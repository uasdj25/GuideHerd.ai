'use strict';

/**
 * Native cancellation (GitLab #81) — GuideHerd owns the cancellation of
 * a governed native booking, with the same discipline as booking itself:
 *
 *   booked ──beginCancellation()──► cancellation_pending
 *                │ provider cancel (ONE attempt, correlation-verified)
 *                ├─ confirmed / event definitively gone ──► cancelled
 *                ├─ definitive provider refusal ──► booked (REVERTED —
 *                │    the appointment still stands; the caller is never
 *                │    told "cancelled" on a refusal)
 *                └─ ambiguous / integrity alarm ──► verification_required
 *                     (the cancellation INTENT stays recorded — an
 *                      operator resolves from provider evidence; the
 *                      caller is told neither "cancelled" nor "still
 *                      booked")
 *
 * Rules carried over unchanged: single provider attempt (no retry after
 * ambiguity), correlation verified before any mutation, tenant-scoped
 * lookups indistinguishable from unknown, fail-closed on missing
 * configuration, no attendee PII in contexts/audit/telemetry. The
 * cancellation cutoff is tenant policy
 * (scheduling/booking-window.cancellationCutoffMinutes). A row in
 * cancellation_pending KEEPS occupying its calendar slot (guard + the
 * provider event both still exist) until the outcome is known.
 *
 * Surfaces: the Operations Center drives this for operators (#93); the
 * secure customer manage link drives it for callers (#89). Notification
 * delivery rides #88 off the audit/telemetry trail — this module emits
 * the intent, never the email.
 */

const { readDomain } = require('../configuration/framework');
const { BookingContextStatus } = require('./booking-context-store');
const {
  CalendarWriteRejectedError,
  CalendarWriteUnverifiedError,
} = require('./calendar-provider');

/**
 * @param {{
 *   bookingContexts: object,
 *   calendarProviders: Record<string, object>,
 *   configService: object,
 *   organizationKey: string,
 *   bookingContextId: string,
 *   clock: { now(): number },
 *   telemetry?: { event: Function },
 *   correlationId?: string,
 *   actor?: 'operator'|'caller-flow',
 * }} args
 * @returns {Promise<{ outcome: 'cancelled'|'rejected'|'verification_required',
 *                     reason?: string, bookingContextId: string|null }>}
 */
async function cancelAppointment({
  bookingContexts, calendarProviders = {}, configService, organizationKey,
  bookingContextId, clock, telemetry = null, correlationId, actor = 'operator',
}) {
  const emit = (name, fields) => {
    if (telemetry) {
      telemetry.event(name, {
        severity: name === 'scheduling.booking_cancelled' ? 'info' : 'warn',
        component: 'scheduling', operation: 'cancel',
        organizationKey, correlationId, bookingContextId, ...fields,
      });
    }
  };
  const rejected = (reason) => {
    emit('scheduling.cancellation_rejected', { code: reason });
    return { outcome: 'rejected', reason, bookingContextId };
  };

  const context = await bookingContexts.get(bookingContextId);
  // Unknown and cross-tenant are deliberately the same answer.
  if (!context || context.organizationKey !== organizationKey) {
    return rejected('booking_not_found');
  }
  if (context.status !== BookingContextStatus.BOOKED) {
    return rejected('booking_not_cancellable');
  }
  if (!context.providerKey) {
    // Legacy provider bookings are managed through that provider's own
    // channels until decommission — never half-cancelled from here.
    return rejected('cancellation_not_supported');
  }
  const provider = calendarProviders[context.providerKey];
  if (!provider || !context.providerEventId || !context.calendarRef) {
    return rejected('cancellation_not_configured');
  }
  const { value: bookingWindow } = readDomain(configService, 'booking-window', organizationKey);
  const cutoffMs = bookingWindow.cancellationCutoffMinutes * 60_000;
  if (context.selectedStartsAt && clock.now() + cutoffMs > Date.parse(context.selectedStartsAt)) {
    return rejected('cancellation_cutoff');
  }

  // Atomic single-winner: two concurrent cancel requests never both
  // reach the provider.
  const pending = await bookingContexts.beginCancellation({ bookingContextId, actor });
  if (!pending) return rejected('booking_not_cancellable');

  let outcome;
  try {
    await provider.cancelEvent({
      calendarRef: context.calendarRef,
      providerEventId: context.providerEventId,
      correlationId: context.bookingContextId,
    });
    outcome = { status: BookingContextStatus.CANCELLED, reason: null };
  } catch (err) {
    if (err instanceof CalendarWriteRejectedError && err.detail === 'event_not_found') {
      // Definitive provider truth: the event no longer exists — there is
      // nothing left to cancel. Terminal cancelled, with the reason kept.
      outcome = { status: BookingContextStatus.CANCELLED, reason: 'event_not_found' };
    } else if (err instanceof CalendarWriteRejectedError && err.detail === 'correlation_mismatch') {
      // Integrity alarm: our record points at an event that is not ours.
      // NEVER cancel it; an operator investigates.
      outcome = { status: BookingContextStatus.VERIFICATION_REQUIRED, reason: 'correlation_mismatch' };
    } else if (err instanceof CalendarWriteRejectedError) {
      // The provider definitively refused: the appointment still stands.
      outcome = { status: BookingContextStatus.BOOKED, reason: `cancel_rejected_${err.detail}` };
    } else if (err instanceof CalendarWriteUnverifiedError) {
      // Ambiguous: cancelled or not — unknowable here. The intent stays
      // recorded; reconciliation resolves from provider evidence.
      outcome = { status: BookingContextStatus.VERIFICATION_REQUIRED, reason: `cancellation_${err.detail}` };
    } else {
      // Unknown errors propagate; the stale-cancellation reconciliation
      // flips the stranded pending row loudly.
      throw err;
    }
  }

  const recorded = await bookingContexts.completeCancellation({
    bookingContextId, status: outcome.status, rejectionReason: outcome.reason, actor,
  });
  if (!recorded) {
    // The pending row was already resolved elsewhere (reconciler) —
    // report what the store now says rather than inventing an outcome.
    const after = await bookingContexts.get(bookingContextId);
    if (after && after.status === BookingContextStatus.CANCELLED) {
      emit('scheduling.booking_cancelled', {});
      return { outcome: 'cancelled', bookingContextId };
    }
    emit('scheduling.booking_verification_required', { code: 'cancellation_outcome_unrecorded' });
    return { outcome: 'verification_required', reason: 'cancellation_outcome_unrecorded', bookingContextId };
  }
  if (outcome.status === BookingContextStatus.CANCELLED) {
    emit('scheduling.booking_cancelled', { code: outcome.reason ?? undefined });
    return { outcome: 'cancelled', ...(outcome.reason ? { reason: outcome.reason } : {}), bookingContextId };
  }
  if (outcome.status === BookingContextStatus.BOOKED) {
    return rejected(outcome.reason);
  }
  emit('scheduling.booking_verification_required', { code: outcome.reason });
  return { outcome: 'verification_required', reason: outcome.reason, bookingContextId };
}

module.exports = { cancelAppointment };
