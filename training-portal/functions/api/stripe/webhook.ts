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

  // Grant provisional access — subscription webhook will confirm status
  const resolvedPlanKey = isValidPlanKey(planKey) ? planKey : 'academy_monthly';
  const productKey = getProductKey(resolvedPlanKey);
  await upsertEntitlement(env.DB, user.id, productKey, 'full', true, 'stripe_checkout', null);

  await insertAuditEvent(env.DB, 'checkout.session.completed', {
    userId: user.id,
    stripeEventId,
    payloadSummary: `plan=${resolvedPlanKey} customer=${stripeCustomerId}`,
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

  const userId = customerRow.user_id;
  const priceId = sub.items.data[0]?.price?.id ?? '';
  const planKey = priceIdToPlanKey(priceId, env);
  const productKey = getProductKey(isValidPlanKey(planKey) ? planKey : 'academy_monthly');
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

  await insertAuditEvent(env.DB, eventType, {
    userId,
    stripeEventId,
    payloadSummary: `plan=${planKey} status=${sub.status}`,
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
