import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../_lib/types.js';
import { jsonError, jsonOk } from '../_lib/types.js';
import { isValidPlanKey, getPriceId } from '../_lib/plans.js';
import { getStripe } from '../_lib/stripe.js';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { planKey?: unknown; email?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { planKey, email } = body;

  if (!isValidPlanKey(planKey)) {
    return jsonError('Invalid or missing planKey', 400);
  }

  const priceId = getPriceId(planKey, env);
  if (!priceId) {
    return jsonError(`Price ID not configured for plan: ${planKey}`, 500);
  }

  const baseUrl = env.PUBLIC_SITE_URL || 'https://training.guideherd.ai';

  try {
    const stripe = getStripe(env);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/account/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing.html?checkout=cancelled`,
      ...(email && typeof email === 'string' ? { customer_email: email } : {}),
      metadata: { plan_key: planKey },
    });

    if (!session.url) {
      return jsonError('Stripe did not return a checkout URL', 500);
    }

    return jsonOk({ checkoutUrl: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stripe error';
    console.error('[checkout] Stripe error:', msg);
    return jsonError('Failed to create checkout session', 502);
  }
};

export const onRequestGet: PagesFunction<Env> = async () =>
  jsonError('Method not allowed', 405);
