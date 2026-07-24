-- 0009 — Native scheduling booking-context evolution + scheduling audit
-- (GitLab #80).
--
-- ADDITIVE ONLY, safe on a live 0008 database with rows in flight:
--   * new NULLABLE columns — every deployed row remains valid;
--   * event_type_id widens from NOT NULL to NULLABLE (native rows carry a
--     calendar target instead; legacy writers still always supply it);
--   * a presence CHECK guarantees every row still names exactly where it
--     books: a legacy event type OR a native provider + offered targets;
--   * a partial UNIQUE index adds the GuideHerd-side double-booking guard
--     for NATIVE rows only (legacy rows have calendar_ref NULL and are
--     untouched);
--   * scheduling_audit is a NEW append-only table.
--
-- Rollback is APPLICATION-LEVEL ONLY: deploy a build that does not read
-- the new columns. Never DROP COLUMN/TABLE on a production database.

ALTER TABLE booking_contexts ADD COLUMN provider_key text;
ALTER TABLE booking_contexts ADD COLUMN calendar_ref text;
-- Map of offered startsAt -> { attorneyId, calendarRef }: the exact
-- native target behind each offered timestamp (per-slot attribution for
-- routing-group pools; trivially single-valued for attorney/default
-- routes). Internal identifiers only — never attendee data.
ALTER TABLE booking_contexts ADD COLUMN offered_targets jsonb;
ALTER TABLE booking_contexts ADD COLUMN provider_event_id text;

ALTER TABLE booking_contexts ALTER COLUMN event_type_id DROP NOT NULL;
ALTER TABLE booking_contexts ADD CONSTRAINT booking_contexts_target_presence
  CHECK (event_type_id IS NOT NULL
     OR (provider_key IS NOT NULL AND offered_targets IS NOT NULL));

-- The double-booking guard: at most one non-superseded claim/booking per
-- (organization, calendar, instant). booking_in_progress and booked rows
-- both occupy the slot; terminal rejected/expired/verification rows do
-- not (verification_required is resolved by reconciliation before the
-- slot can be trusted either way — the availability re-check covers the
-- interim).
CREATE UNIQUE INDEX booking_contexts_slot_guard_idx
  ON booking_contexts (organization_key, calendar_ref, selected_starts_at)
  WHERE status IN ('booking_in_progress', 'booked')
    AND calendar_ref IS NOT NULL AND selected_starts_at IS NOT NULL;

-- Append-only scheduling audit history (#80): one record per
-- booking-context state transition and lifecycle operation. Sanitized by
-- construction: internal identifiers, action codes, and small outcome
-- details only — never raw context tokens, never attendee PII, never raw
-- provider payloads. Audit writes are best-effort AFTER the transition
-- commits; a failed audit write is telemetry, never a booking failure.
CREATE TABLE scheduling_audit (
  audit_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_context_id text NOT NULL,
  organization_key   text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  actor              text NOT NULL CHECK (actor IN ('caller-flow', 'operator', 'reconciler', 'system')),
  action             text NOT NULL,
  detail             jsonb
);

CREATE INDEX scheduling_audit_context_idx
  ON scheduling_audit (booking_context_id, occurred_at);
CREATE INDEX scheduling_audit_org_idx
  ON scheduling_audit (organization_key, occurred_at);
