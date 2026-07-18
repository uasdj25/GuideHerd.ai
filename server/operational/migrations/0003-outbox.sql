-- Operational Store 0003: the Durable Event Outbox (ADR-0017).
--
-- outbox_events: durable GuideHerd domain events, inserted in the SAME
-- transaction as the business change that produced them (the exact
-- transactional boundary lives with the publishing repository method).
-- Payloads carry safe GuideHerd facts only: identifiers, statuses,
-- timestamps — never tokens, credentials, caller PII, or provider
-- payloads (the publishing repositories enforce this by construction).
--
-- outbox_deliveries: per (event, consumer) delivery state — the
-- at-least-once ledger. Claims are atomic conditional writes; 'completed'
-- and 'abandoned' are terminal. Additive-only per ADR-0006 policy.

CREATE TABLE outbox_events (
  id               BIGSERIAL PRIMARY KEY,
  event_type       text NOT NULL,
  organization_key text NOT NULL,
  session_id       text,
  correlation_id   text,
  payload_json     text NOT NULL,
  created_at       timestamptz NOT NULL
);

CREATE INDEX idx_outbox_events_org_recent
  ON outbox_events (organization_key, id DESC);

CREATE TABLE outbox_deliveries (
  event_id        bigint NOT NULL REFERENCES outbox_events (id),
  consumer        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('processing','completed','failed','abandoned')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (event_id, consumer)
);

CREATE INDEX idx_outbox_deliveries_retry
  ON outbox_deliveries (consumer, status, next_attempt_at);
