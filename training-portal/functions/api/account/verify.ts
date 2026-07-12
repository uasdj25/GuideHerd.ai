/**
 * GET /api/account/verify?session_id=...
 *
 * Called from /account/success.html immediately after Stripe checkout redirect.
 * Retrieves the Stripe checkout session, confirms payment, finds/creates the
 * user record, and issues a session cookie so the user is immediately logged in.
 *
 * Safe to call multiple times — all operations are idempotent.
 */

import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../_lib/types.js';
import { jsonError, jsonOk } from '../../_lib/types.js';
import { getStripe } from '../../_lib/stripe.js';
import { getProductKey, isValidPlanKey } from '../../_lib/plans.js';
import {
  upsertUser,
  upsertStripeCustomer,
  upsertEntitlement,
  insertAuditEvent,
} from '../../_lib/db.js';
import { createSessionCookie } from '../../_lib/auth.js';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');

  if (!sessionId || !sessionId.startsWith('cs_')) {
    return jsonError('Missing or invalid session_id', 400);
  }

  const stripe = getStripe(env);

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription'],
    });
  } catch {
    return jsonError('Could not retrieve checkout session', 404);
  }

  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return jsonError('Payment not completed', 402);
  }

  const email = session.customer_details?.email ?? session.customer_email;
  const name = session.customer_details?.name ?? null;
  const stripeCustomerId =
    typeof session.customer === 'string'
      ? session.customer
      : (session.customer as { id: string } | null)?.id ?? null;

  if (!email || !stripeCustomerId) {
    return jsonError('Incomplete checkout session data', 500);
  }

  const user = await upsertUser(env.DB, email, name);
  await upsertStripeCustomer(env.DB, user.id, stripeCustomerId);

  const rawPlanKey = (session.metadata?.plan_key ?? '').toString();

  // Fail closed: no provisional access and no session cookie for unknown plan keys.
  if (!isValidPlanKey(rawPlanKey)) {
    await insertAuditEvent(env.DB, 'account.verify.invalid_plan_key', {
      userId: user.id,
      payloadSummary: `raw_plan=${rawPlanKey}`,
    });
    return jsonError('Invalid or missing plan in checkout session', 400);
  }

  const productKey = getProductKey(rawPlanKey);

  // Provisional access only — expires in 1 hour. The webhook sync that follows
  // creates a stripe_subscription entitlement and deactivates this row.
  const provisionalExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await upsertEntitlement(env.DB, user.id, productKey, 'full', true, 'stripe_checkout', provisionalExpiresAt);

  await insertAuditEvent(env.DB, 'account.verify.session', {
    userId: user.id,
    payloadSummary: `plan=${rawPlanKey}`,
  });

  const sessionCookie = await createSessionCookie(user.id, env.SESSION_SECRET);

  return new Response(
    JSON.stringify({
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie,
      },
    },
  );
};
