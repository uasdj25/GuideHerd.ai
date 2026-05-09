import type { Env, PlanKey } from './types.js';

export const VALID_PLAN_KEYS: readonly PlanKey[] = [
  'academy_monthly',
  'academy_annual',
  'academy_founding_monthly',
  'academy_plus_monthly',
  'academy_plus_annual',
  'workflow_support_monthly',
  'workflow_support_annual',
];

export function isValidPlanKey(key: unknown): key is PlanKey {
  return typeof key === 'string' && VALID_PLAN_KEYS.includes(key as PlanKey);
}

const PLAN_ENV_MAP: Record<PlanKey, keyof Env> = {
  academy_monthly:           'STRIPE_ACADEMY_MONTHLY_PRICE_ID',
  academy_annual:            'STRIPE_ACADEMY_ANNUAL_PRICE_ID',
  academy_founding_monthly:  'STRIPE_ACADEMY_FOUNDING_MONTHLY_PRICE_ID',
  academy_plus_monthly:      'STRIPE_ACADEMY_PLUS_MONTHLY_PRICE_ID',
  academy_plus_annual:       'STRIPE_ACADEMY_PLUS_ANNUAL_PRICE_ID',
  workflow_support_monthly:  'STRIPE_WORKFLOW_SUPPORT_MONTHLY_PRICE_ID',
  workflow_support_annual:   'STRIPE_WORKFLOW_SUPPORT_ANNUAL_PRICE_ID',
};

export function getPriceId(planKey: PlanKey, env: Env): string | null {
  const envKey = PLAN_ENV_MAP[planKey];
  const priceId = env[envKey] as string | undefined;
  return priceId || null;
}

// Product key granted when a plan is active.
// All current plans grant 'academy' access.
export function getProductKey(_planKey: PlanKey): string {
  return 'academy';
}
