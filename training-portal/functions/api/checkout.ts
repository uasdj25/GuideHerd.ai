import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../_lib/types.js';
import { jsonError, jsonOk } from '../_lib/types.js';
import { isValidPlanKey, getPriceId } from '../_lib/plans.js';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
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

    if (!env.STRIPE_SECRET_KEY) {
      return jsonError('Stripe secret key is not configured', 500);
    }

    const baseUrl = env.PUBLIC_SITE_URL || 'https://training.guideherd.ai';

    const params = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${baseUrl}/account/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing.html?checkout=cancelled`,
      'metadata[plan_key]': planKey,
    });

    if (email && typeof email === 'string') {
      params.set('customer_email', email);
    }

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[checkout] Stripe error:', res.status, text.slice(0, 500));
      return jsonError('Failed to create checkout session', 502);
    }

    const data = await res.json() as { url?: string };

    if (!data.url) {
      return jsonError('Stripe did not return a checkout URL', 500);
    }

    return jsonOk({ checkoutUrl: data.url });

  } catch (err) {
    const e = err as { name?: string; message?: string; stack?: string };
    console.error(
      '[checkout] unhandled error',
      e?.name,
      e?.message,
      e?.stack?.slice(0, 1000),
    );
    return jsonError('Checkout handler crashed before completing', 500);
  }
};

export const onRequestGet: PagesFunction<Env> = async () =>
  jsonError('Method not allowed', 405);
