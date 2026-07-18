-- Operational Store 0002: notification delivery idempotency (ADR-0011).
--
-- One row per logical customer notification, keyed by the GuideHerd
-- notificationKey (e.g. 'appointment-confirmation:<sessionId>'). The row
-- is the durable claim that makes retries unable to duplicate a customer
-- notification across restarts and API instances: 'sent' is final and
-- never re-claimed.
--
-- Never stored here: message content, recipient addresses or names,
-- provider payloads, credentials. The key carries GuideHerd identifiers
-- only. Additive-only, per ADR-0006 migration policy.

CREATE TABLE notification_deliveries (
  notification_key  text PRIMARY KEY,
  status            text NOT NULL CHECK (status IN ('pending','sent','failed','not-configured')),
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL
);
