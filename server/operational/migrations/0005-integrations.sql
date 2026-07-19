-- Operational Store 0005: integration delivery idempotency (ADR-0020).
--
-- One row per logical system-to-system effect, keyed by the GuideHerd
-- integrationKey ('<type>:<logical-event-id>', e.g.
-- 'demo-record-sync:<sessionId>'). The row is the durable claim that makes
-- at-least-once triggers (outbox redeliveries, scheduler retries, replayed
-- workflow signals) unable to duplicate an effect in an external business
-- system, across restarts and API instances: 'completed' is final and
-- never re-claimed.
--
-- Never stored here: request facts, provider payloads, customer data,
-- credentials. The key carries GuideHerd identifiers only. Additive-only,
-- per ADR-0006 migration policy.

CREATE TABLE integration_deliveries (
  integration_key  text PRIMARY KEY,
  status           text NOT NULL CHECK (status IN ('pending','completed','failed','not-configured')),
  claimed_at       timestamptz,
  created_at       timestamptz NOT NULL
);
