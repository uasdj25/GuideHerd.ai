import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../_lib/types.js';
import { jsonError, jsonOk } from '../_lib/types.js';
import { requireUser } from '../_lib/auth.js';
import { getStripe } from '../_lib/stripe.js';
import { findStripeCustomerByStripeId } from '../_lib/db.js';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const userOrResponse = await requireUser(request, env);
  if (userOrResponse instanceof Response) return userOrResponse;

  const user = userOrResponse;
  const baseUrl = env.PUBLIC_SITE_URL || 'https://training.guideherd.ai';

  // Look up the Stripe customer record for this user
  const customerRow = await env.DB
    .prepare('SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ? LIMIT 1')
    .bind(user.id)
    .first<{ stripe_customer_id: string }>();

  if (!customerRow) {
    return jsonError('No billing account found for this user', 404);
  }

  const stripe = getStripe(env);

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerRow.stripe_customer_id,
      return_url: `${baseUrl}/account/`,
    });

    return jsonOk({ portalUrl: portalSession.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stripe error';
    console.error('[portal] Stripe error:', msg);
    return jsonError('Failed to create billing portal session', 502);
  }
};

export const onRequestGet: PagesFunction<Env> = async () =>
  jsonError('Method not allowed', 405);
