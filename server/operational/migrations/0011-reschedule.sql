-- 0011 — Rescheduling lifecycle (GitLab #82).
--
-- ADDITIVE ONLY in effect: one nullable lineage column, a status-CHECK
-- widening (constraint swap; every existing row remains valid), and a
-- slot-guard predicate widening. No data is touched. Rollback is
-- APPLICATION-LEVEL ONLY.
--
-- Model: a reschedule is a governed RE-OFFER on the SAME resolved
-- scheduling target. The new offer is a fresh booking context whose
-- reschedule_of names the original; on confirmation the provider event
-- is UPDATED and the original becomes terminal 'rescheduled' while the
-- new context becomes 'booked' (same provider event). The invariant —
-- never zero and never two live appointments — holds because:
--   * 'rescheduling' (original, update in flight) keeps occupying the
--     OLD instant via the guard, while the new instant is held by the
--     reschedule context's claim;
--   * every failure path resolves to exactly one of: reverted-to-booked,
--     rescheduled+booked, or verification_required (operator resolves
--     from provider evidence — the event's actual current start).

ALTER TABLE booking_contexts ADD COLUMN reschedule_of text;

ALTER TABLE booking_contexts DROP CONSTRAINT booking_contexts_status_check;
ALTER TABLE booking_contexts ADD CONSTRAINT booking_contexts_status_check
  CHECK (status IN ('offered', 'booking_in_progress', 'booked', 'rejected',
                    'expired', 'verification_required',
                    'cancellation_pending', 'cancelled',
                    'rescheduling', 'rescheduled'));

DROP INDEX booking_contexts_slot_guard_idx;
CREATE UNIQUE INDEX booking_contexts_slot_guard_idx
  ON booking_contexts (organization_key, calendar_ref, selected_starts_at)
  WHERE status IN ('booking_in_progress', 'booked', 'cancellation_pending', 'rescheduling')
    AND calendar_ref IS NOT NULL AND selected_starts_at IS NOT NULL;

CREATE INDEX booking_contexts_reschedule_of_idx
  ON booking_contexts (reschedule_of) WHERE reschedule_of IS NOT NULL;
