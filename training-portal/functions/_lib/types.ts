// Shared types for GuideHerd Academy Pages Functions

export interface Env {
  // D1 database binding — configured in Cloudflare dashboard as "DB"
  DB: D1Database;

  // Stripe
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  // Stripe Price IDs — one env var per plan
  STRIPE_ACADEMY_MONTHLY_PRICE_ID: string;
  STRIPE_ACADEMY_ANNUAL_PRICE_ID: string;
  STRIPE_ACADEMY_FOUNDING_MONTHLY_PRICE_ID: string;
  STRIPE_ACADEMY_PLUS_MONTHLY_PRICE_ID: string;
  STRIPE_ACADEMY_PLUS_ANNUAL_PRICE_ID: string;
  STRIPE_WORKFLOW_SUPPORT_MONTHLY_PRICE_ID: string;
  STRIPE_WORKFLOW_SUPPORT_ANNUAL_PRICE_ID: string;

  // App config
  PUBLIC_SITE_URL: string;
  SESSION_SECRET: string;

  // Development only — must be explicitly set to "true" to enable mock access.
  // Never set this in production.
  ALLOW_MOCK_ACCESS?: string;
}

export type PlanKey =
  | 'academy_monthly'
  | 'academy_annual'
  | 'academy_founding_monthly'
  | 'academy_plus_monthly'
  | 'academy_plus_annual'
  | 'workflow_support_monthly'
  | 'workflow_support_annual';

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  updated_at: string;
}

export interface StripeCustomer {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  plan_key: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

export interface AccessEntitlement {
  id: string;
  user_id: string;
  product_key: string;
  access_level: string;
  active: number;
  source: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
