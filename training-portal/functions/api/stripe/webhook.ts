import type { PagesFunction } from '@cloudflare/workers-types';
import Stripe from 'stripe';
import type { Env } from '../../_lib/types.js';
import { jsonError, jsonOk } from '../../_lib/types.js';
import { getStripe } from '../../_lib/stripe.js';
import { getProductKey, isValidPlanKey } from '../../_lib/plans.js';
import {
  upsertUser,
  upsertStripeCustomer,
  upsertSubscription,
  upsertEntitlement,
  insertAuditEvent,
  deactivateCheckoutEntitlements,
  deactivateAllEntitlements,
} from '../../_lib/db.js';

// Price ID → plan key reverse map built at runtime from env
function priceIdToPlanKey(priceId: string, env: Env): string {
  const pairs: [string, string][] = [
    [env.STRIPE_ACADEMY_MONTHLY_PRICE_ID,           'academy_monthly'],
    [env.STRIPE_ACADEMY_ANNUAL_PRICE_ID,            'academy_annual'],
    [env.STRIPE_ACADEMY_FOUNDING_MONTHLY_PRICE_ID,  'academy_founding_monthly'],
    [env.STRIPE_ACADEMY_PLUS_MONTHLY_PRICE_ID,      'academy_plus_monthly'],
    [env.STRIPE_ACADEMY_PLUS_ANNUAL_PRICE_ID,       'academy_plus_annual'],
    [env.STRIPE_WORKFLOW_SUPPORT_MONTHLY_PRICE_ID,  'workflow_support_monthly'],
    [env.STRIPE_WORKFLOW_SUPPORT_ANNUAL_PRICE_ID,   'workflow_support_annual'],
  ];
  return pairs.find(([id]) => id === priceId)?.[1] ?? 'unknown';
}

function periodEnd(sub: Stripe.Subscription): string | null {
  return sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
}

// ── Plan key resolution from subscription ─────────────────────────────────────

function resolvePlanKeyFromSub(sub: Stripe.Subscription, env: Env): PlanKey | null {
  const priceId = sub.items.data[0]?.price?.id ?? '';
  const raw = priceIdToPlanKey(priceId, env);
  return isValidPlanKey(raw) ? raw : null;
}

// ── Shared subscription persistence ──────────────────────────────────────────
// Extracted so handleCheckoutCompleted can call it to reconcile the subscription
// immediately, avoiding the race where customer.subscription.created arrives
// before the checkout.session.completed handler has written stripe_customers.
// Callers must resolve and validate planKey before calling — never falls back.
// Does not insert an audit event — callers handle that themselves.

async function syncSubscriptionForUser(
  sub: Stripe.Subscription,
  env: Env,
  userId: string,
  stripeCustomerId: string,
  planKey: PlanKey,
): Promise<{ status: string; productKey: string }> {
  const priceId = sub.items.data[0]?.price?.id ?? '';
  const productKey = getProductKey(planKey);
  const isActive = sub.status === 'active' || sub.status === 'trialing';

  await upsertSubscription(env.DB, {
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    plan_key: planKey,
    status: sub.status,
    current_period_end: periodEnd(sub),
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
  });

  await upsertEntitlement(env.DB, userId, productKey, 'full', isActive, 'stripe_subscription', periodEnd(sub));

  return { status: sub.status, productKey };
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  env: Env,
  stripeEventId: string,
): Promise<void> {
  const email = session.customer_details?.email ?? session.customer_email;
  const name = session.customer_details?.name ?? null;
  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : null;
  const planKey = (session.metadata?.plan_key ?? '').toString();

  if (!email || !stripeCustomerId) {
    await insertAuditEvent(env.DB, 'checkout.session.completed.skipped', {
      stripeEventId,
      payloadSummary: 'missing email or customer_id',
    });
    return;
  }

  const user = await upsertUser(env.DB, email, name);
  await upsertStripeCustomer(env.DB, user.id, stripeCustomerId);

  // Fail closed: unknown or unmapped plan_key must not create any entitlement.
  if (!isValidPlanKey(planKey)) {
    await insertAuditEvent(env.DB, 'checkout.invalid_plan_key', {
      userId: user.id,
      stripeEventId,
      payloadSummary: `raw_plan=${planKey}`,
    });
    return;
  }

  // Provisional access — expires in 1 hour as a safety net if sync below fails.
  // The stripe_subscription entitlement created by a successful sync replaces this.
  const productKey = getProductKey(planKey);
  const provisionalExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await upsertEntitlement(env.DB, user.id, productKey, 'full', true, 'stripe_checkout', provisionalExpiresAt);

  // Reconcile subscription immediately if available, fixing the race where
  // customer.subscription.created arrives before stripe_customers row exists.
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
  if (subscriptionId) {
    try {
      const stripe = getStripe(env);
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const subPlanKey = resolvePlanKeyFromSub(sub, env);
      if (!subPlanKey) {
        // Price ID does not match any known plan — log and leave provisional access.
        await insertAuditEvent(env.DB, 'checkout.subscription_sync.invalid_plan_key', {
          userId: user.id,
          payloadSummary: `checkout_plan=${planKey}`,
        });
      } else {
        // Omit stripeEventId here to avoid collision with the primary audit row below
        const synced = await syncSubscriptionForUser(sub, env, user.id, stripeCustomerId, subPlanKey);
        await insertAuditEvent(env.DB, 'checkout.session.completed.subscription_synced', {
          userId: user.id,
          payloadSummary: `plan=${subPlanKey} status=${synced.status}`,
        });
        // Subscription is now active — retire the provisional checkout entitlement
        await deactivateCheckoutEntitlements(env.DB, user.id, synced.productKey);
        await insertAuditEvent(env.DB, 'checkout.provisional_access.deactivated', {
          userId: user.id,
          payloadSummary: `product=${synced.productKey}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[webhook] subscription sync failed after checkout:', msg);
      // Non-fatal: provisional entitlement expires in 1 hour
    }
  }

  // Primary audit event — uses stripeEventId for idempotency
  await insertAuditEvent(env.DB, 'checkout.session.completed', {
    userId: user.id,
    stripeEventId,
    payloadSummary: `plan=${planKey}`,
  });
}

async function handleSubscriptionEvent(
  sub: Stripe.Subscription,
  env: Env,
  stripeEventId: string,
  eventType: string,
): Promise<void> {
  const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : null;
  if (!stripeCustomerId) return;

  const customerRow = await env.DB
    .prepare('SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ?')
    .bind(stripeCustomerId)
    .first<{ user_id: string }>();

  if (!customerRow) {
    await insertAuditEvent(env.DB, `${eventType}.no_user`, {
      stripeEventId,
      payloadSummary: `customer=${stripeCustomerId}`,
    });
    return;
  }

  const planKey = resolvePlanKeyFromSub(sub, env);

  if (!planKey) {
    // For deletions, attempt revocation via the existing DB record to avoid stranded access.
    if (eventType === 'customer.subscription.deleted') {
      const existing = await env.DB
        .prepare('SELECT plan_key FROM subscriptions WHERE stripe_subscription_id = ?')
        .bind(sub.id)
        .first<{ plan_key: string }>();
      if (existing && isValidPlanKey(existing.plan_key)) {
        await deactivateAllEntitlements(env.DB, customerRow.user_id, getProductKey(existing.plan_key));
      }
    }
    await insertAuditEvent(env.DB, 'subscription.invalid_plan_key', {
      userId: customerRow.user_id,
      stripeEventId,
      payloadSummary: `event=${eventType}`,
    });
    return;
  }

  const { status, productKey } = await syncSubscriptionForUser(
    sub,
    env,
    customerRow.user_id,
    stripeCustomerId,
    planKey,
  );

  if (eventType === 'customer.subscription.deleted') {
    await deactivateAllEntitlements(env.DB, customerRow.user_id, productKey);
    await insertAuditEvent(env.DB, 'access.revoked.subscription_deleted', {
      userId: customerRow.user_id,
      payloadSummary: `product=${productKey}`,
    });
  } else if (
    eventType === 'customer.subscription.updated' &&
    status !== 'active' &&
    status !== 'trialing'
  ) {
    await deactivateAllEntitlements(env.DB, customerRow.user_id, productKey);
    await insertAuditEvent(env.DB, 'access.revoked.subscription_inactive', {
      userId: customerRow.user_id,
      payloadSummary: `product=${productKey} status=${status}`,
    });
  }

  await insertAuditEvent(env.DB, eventType, {
    userId: customerRow.user_id,
    stripeEventId,
    payloadSummary: `plan=${planKey} status=${status}`,
  });
}

async function handleInvoiceEvent(
  invoice: Stripe.Invoice,
  env: Env,
  stripeEventId: string,
  eventType: string,
): Promise<void> {
  const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : null;
  if (!stripeCustomerId) return;

  const customerRow = await env.DB
    .prepare('SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ?')
    .bind(stripeCustomerId)
    .first<{ user_id: string }>();

  const userId = customerRow?.user_id ?? null;

  await insertAuditEvent(env.DB, eventType, {
    userId: userId ?? undefined,
    stripeEventId,
    payloadSummary: `status=${invoice.status} customer=${stripeCustomerId}`,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) return jsonError('Missing stripe-signature header', 400);

  const stripe = getStripe(env);
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return jsonError('Invalid webhook signature', 400);
  }

  // Idempotency: check audit_events for this stripe_event_id
  const already = await env.DB
    .prepare('SELECT id FROM audit_events WHERE stripe_event_id = ? LIMIT 1')
    .bind(event.id)
    .first<{ id: string }>();

  if (already) {
    return jsonOk({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, env, event.id);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionEvent(event.data.object as Stripe.Subscription, env, event.id, event.type);
        break;

      case 'invoice.paid':
      case 'invoice.payment_failed':
        await handleInvoiceEvent(event.data.object as Stripe.Invoice, env, event.id, event.type);
        break;

      default:
        await insertAuditEvent(env.DB, event.type, { stripeEventId: event.id, payloadSummary: 'unhandled' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] Error handling ${event.type}:`, msg);
    return jsonError('Webhook handler error', 500);
  }

  return jsonOk({ received: true });
};

export const onRequestGet: PagesFunction<Env> = async () =>
  jsonError('Method not allowed', 405);
