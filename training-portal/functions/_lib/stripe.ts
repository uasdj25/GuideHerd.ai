import Stripe from 'stripe';
import type { Env } from './types.js';

export function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-04-30.basil',
    httpClient: Stripe.createFetchHttpClient(),
  });
}
