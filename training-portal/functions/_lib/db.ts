import type { Env, User, StripeCustomer, Subscription, AccessEntitlement } from './types.js';

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function findUserByEmail(db: Env['DB'], email: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
}

export async function findUserById(db: Env['DB'], id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function upsertUser(
  db: Env['DB'],
  email: string,
  name: string | null,
): Promise<User> {
  const ts = now();
  const existing = await findUserByEmail(db, email);
  if (existing) {
    await db
      .prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?')
      .bind(name ?? existing.name, ts, existing.id)
      .run();
    return { ...existing, name: name ?? existing.name, updated_at: ts };
  }
  const id = newId();
  await db
    .prepare('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, name, ts, ts)
    .run();
  return { id, email, name, created_at: ts, updated_at: ts };
}

// ── Stripe customers ──────────────────────────────────────────────────────────

export async function findStripeCustomerByStripeId(
  db: Env['DB'],
  stripeCustomerId: string,
): Promise<StripeCustomer | null> {
  return db
    .prepare('SELECT * FROM stripe_customers WHERE stripe_customer_id = ?')
    .bind(stripeCustomerId)
    .first<StripeCustomer>();
}

export async function upsertStripeCustomer(
  db: Env['DB'],
  userId: string,
  stripeCustomerId: string,
): Promise<void> {
  const ts = now();
  const existing = await findStripeCustomerByStripeId(db, stripeCustomerId);
  if (existing) {
    await db
      .prepare('UPDATE stripe_customers SET updated_at = ? WHERE id = ?')
      .bind(ts, existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      'INSERT INTO stripe_customers (id, user_id, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(newId(), userId, stripeCustomerId, ts, ts)
    .run();
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export async function upsertSubscription(
  db: Env['DB'],
  data: Omit<Subscription, 'id' | 'created_at' | 'updated_at'>,
): Promise<void> {
  const ts = now();
  const existing = await db
    .prepare('SELECT id, created_at FROM subscriptions WHERE stripe_subscription_id = ?')
    .bind(data.stripe_subscription_id)
    .first<{ id: string; created_at: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE subscriptions SET
           stripe_price_id = ?, plan_key = ?, status = ?,
           current_period_end = ?, cancel_at_period_end = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        data.stripe_price_id,
        data.plan_key,
        data.status,
        data.current_period_end,
        data.cancel_at_period_end,
        ts,
        existing.id,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO subscriptions
           (id, user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
            plan_key, status, current_period_end, cancel_at_period_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        data.user_id,
        data.stripe_customer_id,
        data.stripe_subscription_id,
        data.stripe_price_id,
        data.plan_key,
        data.status,
        data.current_period_end,
        data.cancel_at_period_end,
        ts,
        ts,
      )
      .run();
  }
}

// ── Access entitlements ───────────────────────────────────────────────────────

export async function upsertEntitlement(
  db: Env['DB'],
  userId: string,
  productKey: string,
  accessLevel: string,
  active: boolean,
  source: string,
  expiresAt: string | null,
): Promise<void> {
  const ts = now();
  const existing = await db
    .prepare(
      'SELECT id FROM access_entitlements WHERE user_id = ? AND product_key = ? AND source = ?',
    )
    .bind(userId, productKey, source)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE access_entitlements
         SET access_level = ?, active = ?, expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(accessLevel, active ? 1 : 0, expiresAt, ts, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO access_entitlements
           (id, user_id, product_key, access_level, active, source, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), userId, productKey, accessLevel, active ? 1 : 0, source, expiresAt, ts, ts)
      .run();
  }
}

export async function hasActiveEntitlement(
  db: Env['DB'],
  userId: string,
  productKey: string,
): Promise<{ active: boolean; plan_key: string | null }> {
  const row = await db
    .prepare(
      `SELECT ae.active, s.plan_key
       FROM access_entitlements ae
       LEFT JOIN subscriptions s ON s.user_id = ae.user_id AND s.status = 'active'
       WHERE ae.user_id = ? AND ae.product_key = ? AND ae.active = 1
       LIMIT 1`,
    )
    .bind(userId, productKey)
    .first<{ active: number; plan_key: string | null }>();

  if (!row) return { active: false, plan_key: null };
  return { active: row.active === 1, plan_key: row.plan_key };
}

export async function getActiveSubscription(
  db: Env['DB'],
  userId: string,
): Promise<Subscription | null> {
  return db
    .prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1`)
    .bind(userId)
    .first<Subscription>();
}

// ── Audit events ──────────────────────────────────────────────────────────────

export async function insertAuditEvent(
  db: Env['DB'],
  eventType: string,
  options: { userId?: string; stripeEventId?: string; payloadSummary?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (id, event_type, user_id, stripe_event_id, payload_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      eventType,
      options.userId ?? null,
      options.stripeEventId ?? null,
      options.payloadSummary ?? null,
      now(),
    )
    .run();
}
