-- Operational Store 0001: durable handoff sessions (ADR-0006, Phase 1).
--
-- One row per prepared handoff session — the durable form of the in-memory
-- InternalSession. Outcome and summary-delivery state are folded into the
-- session row while the relationship is 1:1; they graduate to their own
-- tables when Conversation records arrive (Phase C).
--
-- Never stored here: raw tokens (hashes only), bridge/provider secrets,
-- transcripts, recordings, raw provider payloads, legal matter narratives.
-- The outcome contract's strict allowlist is enforced at the API edge before
-- anything reaches this table.

CREATE TABLE handoff_sessions (
  session_id              text PRIMARY KEY,
  organization_key        text NOT NULL,
  status                  text NOT NULL CHECK (status IN
    ('awaiting-transfer','connected','scheduling','booked','failed','escalated','cancelled','expired')),

  -- Caller context: the minimum required for the handoff. Subject to the
  -- retention policy in ADR-0006.
  caller_full_name        text NOT NULL,
  caller_email            text NOT NULL,
  caller_phone            text,
  -- E.164-normalized phone, reserved for the concurrent-transfer correlation
  -- ticket. Unpopulated in Phase 1.
  caller_phone_normalized text,

  -- Scheduling references: Configuration Store keys, deliberately NOT
  -- foreign keys — the stores have independent lifecycles (ADR-0004/0006).
  attorney_id             text,
  practice_area_id        text,
  consultation_type_id    text NOT NULL,

  handoff_source          text NOT NULL,
  handoff_mode            text NOT NULL,
  created_by_user_id      text,

  -- Credentials: SHA-256 hashes only. Raw tokens are never persisted.
  token_hash              text NOT NULL UNIQUE,
  console_token_hash      text NOT NULL,

  -- Terminal outcome (canonical normalized JSON, serialized by the service —
  -- stored as text so duplicate detection is exact string equality).
  outcome_json            text,

  -- Consultation Summary delivery sub-state (null = never attempted).
  summary_delivery        text CHECK (summary_delivery IN ('pending','sent','failed','not-configured')),
  summary_claimed_at      timestamptz,

  created_at              timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  connected_at            timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,

  -- Optimistic concurrency token for future editors; the Phase 1 transitions
  -- rely on conditional updates and row locks, not this column.
  version                 integer NOT NULL DEFAULT 0
);

-- Eligibility scans (connect: awaiting-transfer sessions for one firm).
CREATE INDEX idx_handoff_sessions_eligibility
  ON handoff_sessions (organization_key, status, expires_at);

-- Latest completed summary for a firm.
CREATE INDEX idx_handoff_sessions_latest
  ON handoff_sessions (organization_key, completed_at DESC)
  WHERE status IN ('booked','failed','escalated');

-- Tenant-scoped phone correlation (unused until the correlation ticket).
CREATE INDEX idx_handoff_sessions_phone
  ON handoff_sessions (organization_key, caller_phone_normalized)
  WHERE caller_phone_normalized IS NOT NULL;
