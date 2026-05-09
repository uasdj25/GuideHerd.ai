-- GuideHerd Academy — D1 initial migration
-- Run with: wrangler d1 migrations apply guideherd-academy-db

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_customers (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  stripe_customer_id  TEXT UNIQUE NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  stripe_customer_id       TEXT NOT NULL,
  stripe_subscription_id   TEXT UNIQUE NOT NULL,
  stripe_price_id          TEXT NOT NULL,
  plan_key                 TEXT NOT NULL,
  status                   TEXT NOT NULL,
  current_period_end       TEXT,
  cancel_at_period_end     INTEGER DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_entitlements (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  product_key  TEXT NOT NULL,
  access_level TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id               TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  user_id          TEXT,
  stripe_event_id  TEXT,
  payload_summary  TEXT,
  created_at       TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email);

CREATE INDEX IF NOT EXISTS idx_stripe_customers_stripe_id
  ON stripe_customers (stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
  ON subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id
  ON subscriptions (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_access_entitlements_user_id
  ON access_entitlements (user_id);

CREATE INDEX IF NOT EXISTS idx_access_entitlements_active
  ON access_entitlements (active);

CREATE INDEX IF NOT EXISTS idx_audit_events_stripe_event_id
  ON audit_events (stripe_event_id);
