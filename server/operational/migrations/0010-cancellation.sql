-- 0010 — Cancellation lifecycle states (GitLab #81).
--
-- ADDITIVE ONLY in effect: the status CHECK widens to admit two new
-- states (a constraint swap changes no data and remains satisfied by
-- every existing row), and the slot-guard index predicate widens so a
-- booking whose cancellation is still in flight KEEPS occupying its
-- calendar instant until the provider confirms the cancel (the event
-- still exists until then). Dropping/recreating an index and a CHECK is
-- schema-safe on a live database; no rows are touched.
--
-- New states:
--   cancellation_pending  booked -> cancel requested; the provider
--                         cancel is in flight (atomic single-winner,
--                         mirroring the booking claim);
--   cancelled             terminal: the provider confirmed (or the event
--                         definitively no longer exists). Frees the slot.
--
-- Ambiguous cancel outcomes land in verification_required with the
-- cancellation intent recorded — never silently cancelled, never
-- silently still-booked. Rollback is APPLICATION-LEVEL ONLY.

ALTER TABLE booking_contexts DROP CONSTRAINT booking_contexts_status_check;
ALTER TABLE booking_contexts ADD CONSTRAINT booking_contexts_status_check
  CHECK (status IN ('offered', 'booking_in_progress', 'booked', 'rejected',
                    'expired', 'verification_required',
                    'cancellation_pending', 'cancelled'));

DROP INDEX booking_contexts_slot_guard_idx;
CREATE UNIQUE INDEX booking_contexts_slot_guard_idx
  ON booking_contexts (organization_key, calendar_ref, selected_starts_at)
  WHERE status IN ('booking_in_progress', 'booked', 'cancellation_pending')
    AND calendar_ref IS NOT NULL AND selected_starts_at IS NOT NULL;
