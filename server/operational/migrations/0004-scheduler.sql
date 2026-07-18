-- ADR-0018: The GuideHerd Scheduler Contract — durable scheduled actions.
-- action_key is the unique identifier AND the structural dedupe boundary:
-- scheduling the same key twice is a conflict-free no-op. All times are
-- UTC (timestamptz); organization timezones are presentation concerns.
-- Payloads carry safe GuideHerd facts only — never tokens, PII, or
-- provider payloads (enforced by producers, tested by scans).

CREATE TABLE scheduled_actions (
  action_key       TEXT PRIMARY KEY,
  action_type      TEXT NOT NULL,
  organization_key TEXT NOT NULL,
  session_id       TEXT,
  correlation_id   TEXT,
  run_at           TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ,
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'cancelled', 'expired')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  payload_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL
);

-- The drain scans for due work by state and time.
CREATE INDEX scheduled_actions_due_idx
  ON scheduled_actions (state, run_at);

-- Operational listings scan by organization, newest scheduled first.
CREATE INDEX scheduled_actions_org_idx
  ON scheduled_actions (organization_key, created_at DESC);
