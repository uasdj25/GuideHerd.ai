'use strict';

/**
 * Automated evidence-based reconciliation (GitLab #87) — the successor
 * of the manual verification_required procedure for NATIVE bookings:
 * every ambiguous outcome is resolved from PROVIDER EVIDENCE (the event
 * located by the GuideHerd correlation identifier, ADR-0024 rule 3) —
 * never by attendee identity, never by same-time inference, never by
 * guesswork.
 *
 * Per verification_required context, by the recorded ambiguity kind:
 *
 *   booking creation   evidence: event with the context's own
 *   (provider_timeout,  correlation. FOUND confirmed -> resolve BOOKED
 *    network_failure,   (with the recovered event id); a successful
 *    provider_http_*,   lookup returning NOTHING is definitive provider
 *    unparseable_…,     truth: nothing was created -> resolve REJECTED.
 *    missing_event_id,
 *    stale_booking_in_progress, booked_result_persistence_failed)
 *
 *   cancellation       evidence: the event's current status. CANCELLED
 *   (cancellation_*,    or ABSENT -> resolve CANCELLED (the intent
 *    stale_cancellation_pending)  succeeded / nothing left); still
 *                      CONFIRMED -> the cancel did NOT happen: resolve
 *                      back to BOOKED (the appointment stands; the
 *                      caller was never told cancelled).
 *
 *   reschedule pair    evidence: the ORIGINAL event's current start
 *   (reschedule_*,      (correlation = the original context id). At the
 *    stale_rescheduling) NEW time -> the move happened: original
 *                      RESCHEDULED, successor BOOKED. At the OLD time ->
 *                      it did not: original BOOKED (reverted), successor
 *                      REJECTED. Anywhere else / absent -> left for the
 *                      operator (never guessed).
 *
 * The reconciler performs NO provider writes, NEVER retries a booking,
 * and on any provider read failure leaves the context QUEUED with loud
 * telemetry — absence of evidence is only acted on when the provider
 * positively answered.
 *
 * Legacy (event-type) contexts are skipped: their procedure remains the
 * documented manual one until decommission.
 */

const { BookingContextStatus } = require('./booking-context-store');

/**
 * @param {{ bookingContexts: object, calendarProviders: Record<string, object>,
 *           telemetry?: { event: Function }, limit?: number }} args
 * @returns {Promise<{ examined: number, resolved: number, left: number }>}
 */
async function reconcileVerificationRequired({
  bookingContexts, calendarProviders = {}, telemetry = null, limit = 50,
}) {
  const emit = (name, context, fields) => {
    if (telemetry) {
      telemetry.event(name, {
        component: 'scheduling', operation: 'booking-reconciliation',
        organizationKey: context.organizationKey,
        sessionId: context.sessionId,
        bookingContextId: context.bookingContextId,
        ...fields,
      });
    }
  };
  if (typeof bookingContexts.listByStatus !== 'function') {
    return { examined: 0, resolved: 0, left: 0 };
  }
  const queued = await bookingContexts.listByStatus({
    status: BookingContextStatus.VERIFICATION_REQUIRED, limit,
  });
  let resolved = 0;
  let left = 0;

  for (const context of queued) {
    if (!context.providerKey || !context.calendarRef) {
      left += 1; // legacy or malformed: the manual procedure owns it
      continue;
    }
    const provider = calendarProviders[context.providerKey];
    if (!provider) {
      left += 1;
      continue;
    }
    const reason = context.rejectionReason || '';
    const isCancellation = reason.startsWith('cancellation_') || reason === 'stale_cancellation_pending';
    const isReschedule = reason.startsWith('reschedule_') || reason === 'stale_rescheduling'
      || Boolean(context.rescheduleOf && !isCancellation);

    let evidence;
    try {
      // Reschedule successors carry the ORIGINAL's correlation (the
      // moved event belongs to the original context).
      const correlationId = context.rescheduleOf ?? context.bookingContextId;
      evidence = await provider.findEventByCorrelation({
        calendarRef: context.calendarRef, correlationId,
      });
    } catch (err) {
      // Provider unreachable: the context STAYS queued, loudly. Never
      // resolved without evidence.
      left += 1;
      emit('scheduling.booking_verification_required', context, {
        severity: 'warn', code: 'reconciliation_evidence_unavailable',
      });
      continue;
    }

    let resolution = null;
    if (isCancellation) {
      resolution = (!evidence || evidence.status === 'cancelled')
        ? { status: BookingContextStatus.CANCELLED, reason: 'reconciled_event_gone' }
        : { status: BookingContextStatus.BOOKED, reason: 'reconciled_event_still_confirmed' };
    } else if (isReschedule && context.rescheduleOf) {
      // The successor of a reschedule pair. Where is the event now?
      const selected = context.selectedStartsAt ? Date.parse(context.selectedStartsAt) : null;
      if (evidence && evidence.startsAt && selected !== null) {
        const atMs = Date.parse(evidence.startsAt);
        if (atMs === selected) {
          // The move happened: successor booked, original rescheduled.
          resolution = {
            status: BookingContextStatus.BOOKED,
            reason: 'reconciled_event_at_new_time',
            providerEventId: evidence.providerEventId,
            also: {
              bookingContextId: context.rescheduleOf,
              status: BookingContextStatus.RESCHEDULED,
              reason: 'reconciled_event_at_new_time',
            },
          };
        } else {
          // Still at (or back at) another time: the move did not happen.
          resolution = {
            status: BookingContextStatus.REJECTED,
            reason: 'reconciled_event_not_moved',
            also: {
              bookingContextId: context.rescheduleOf,
              status: BookingContextStatus.BOOKED,
              reason: 'reconciled_event_not_moved',
            },
          };
        }
      }
      // Absent evidence for a reschedule pair is NOT actionable — the
      // operator decides (the event may have been cancelled entirely).
    } else if (!isReschedule) {
      // Booking-creation ambiguity, this context's own correlation.
      resolution = evidence && evidence.status !== 'cancelled'
        ? {
          status: BookingContextStatus.BOOKED,
          reason: 'reconciled_event_found',
          providerEventId: evidence.providerEventId,
        }
        : { status: BookingContextStatus.REJECTED, reason: 'reconciled_no_event_found' };
    }

    if (!resolution) {
      left += 1;
      continue;
    }
    const applied = await bookingContexts.resolveVerification({
      bookingContextId: context.bookingContextId,
      status: resolution.status,
      ...(resolution.providerEventId ? { providerEventId: resolution.providerEventId } : {}),
      rejectionReason: resolution.reason,
      actor: 'reconciler',
    });
    if (!applied) {
      left += 1;
      continue;
    }
    resolved += 1;
    emit('scheduling.booking_reconciled', context, {
      severity: 'info', status: resolution.status, code: resolution.reason,
    });
    if (resolution.also) {
      const original = await bookingContexts.get(resolution.also.bookingContextId);
      if (original && original.status === BookingContextStatus.VERIFICATION_REQUIRED) {
        const alsoApplied = await bookingContexts.resolveVerification({
          bookingContextId: resolution.also.bookingContextId,
          status: resolution.also.status,
          rejectionReason: resolution.also.reason,
          actor: 'reconciler',
        });
        if (alsoApplied) {
          resolved += 1;
          emit('scheduling.booking_reconciled', original, {
            severity: 'info', status: resolution.also.status, code: resolution.also.reason,
          });
        }
      }
    }
  }
  return { examined: queued.length, resolved, left };
}

module.exports = { reconcileVerificationRequired };
