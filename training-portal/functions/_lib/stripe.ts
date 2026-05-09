import Stripe from 'stripe';
import type { Env } from './types.js';

export function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-04-30.basil',
  });
}
