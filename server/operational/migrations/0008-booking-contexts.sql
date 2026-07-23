-- Operational Store 0008: durable booking contexts (Issue #74 booking parity).
--
-- One row per governed availability offer that may be booked. The row is the
-- SINGLE authoritative routing decision shared by availability and booking:
-- the offered-slots service writes the resolved Cal.com event type and the
-- exact offered timestamps here, and the booking service may only book what
-- this row says — the conversation layer transports an opaque random value
-- and can neither choose nor override an event type.
--
-- Never stored here: the raw bookingContext value (SHA-256 hash only),
-- attendee names/emails/phones (they pass through to the calendar provider
-- and are never persisted for reconciliation), provider credentials, or raw
-- provider payloads (booking_result holds a sanitized subset only).
--
-- Additive-only per ADR-0006: normal rollback is application-only — redeploy
-- the previous image, which ignores this table; the migration and its data
-- stay in place. No destructive rollback step exists in the runbook.

CREATE TABLE booking_contexts (
  booking_context_id   text PRIMARY KEY,
  -- SHA-256 hex of the opaque value handed to the conversation layer.
  context_token_hash   text NOT NULL UNIQUE,
  organization_key     text NOT NULL,
  -- Optional prepared-session correlation; deliberately NOT a foreign key
  -- (sessions and booking contexts have independent lifecycles/retention).
  session_id           text,

  -- The resolved routing decision (route_kind discriminates the shape; the
  -- CHECK below enforces per-kind column consistency at the database).
  route_kind           text NOT NULL CHECK (route_kind IN ('attorney','routing-group','default')),
  attorney_id          text,
  routing_group_key    text,
  practice_area_id     text,
  consultation_type_id text,
  event_type_id        bigint NOT NULL CHECK (event_type_id > 0),
  duration_minutes     integer NOT NULL CHECK (duration_minutes > 0),
  -- The exact offered timestamps (JSON array of ISO strings): booking may
  -- only claim a timestamp that is a member of this array.
  offered_slots        jsonb NOT NULL,

  status               text NOT NULL CHECK (status IN
    ('offered','booking_in_progress','booked','rejected','expired','verification_required')),
  selected_starts_at   timestamptz,
  calcom_booking_uid   text,
  -- Sanitized provider confirmation subset (uid/start/status) — never the
  -- raw provider payload, never attendee data.
  booking_result       jsonb,
  rejection_reason     text,

  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,

  CONSTRAINT booking_contexts_route_consistency CHECK (
    (route_kind = 'attorney'
       AND attorney_id IS NOT NULL AND routing_group_key IS NULL)
    OR (route_kind = 'routing-group'
       AND routing_group_key IS NOT NULL AND attorney_id IS NULL AND practice_area_id IS NOT NULL)
    OR (route_kind = 'default'
       AND attorney_id IS NULL AND routing_group_key IS NULL)
  )
);

-- Startup reconciliation scans: rows a crash may have stranded mid-booking.
CREATE INDEX booking_contexts_open_idx ON booking_contexts (updated_at)
  WHERE status IN ('booking_in_progress','verification_required');

-- Outcome correlation / diagnostics by prepared session.
CREATE INDEX booking_contexts_session_idx ON booking_contexts (session_id)
  WHERE session_id IS NOT NULL;
