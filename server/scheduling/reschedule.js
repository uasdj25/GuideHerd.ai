'use strict';

/**
 * Native rescheduling (GitLab #82) — a governed RE-OFFER on the SAME
 * resolved scheduling target, then a correlation-verified provider
 * UPDATE of the original event. Two phases:
 *
 *   offerReschedule    availability restricted to the original booking's
 *                      calendar target and attributed attorney (route
 *                      re-selection is forbidden — changing attorney is
 *                      a NEW booking through normal routing). Issues a
 *                      fresh booking context whose reschedule_of names
 *                      the original; the original's own interval is
 *                      excluded from busy so moving within the same day
 *                      works.
 *
 *   confirmReschedule  claim the new slot (guard holds the NEW instant)
 *                      -> beginReschedule (the original holds its OLD
 *                      instant) -> busy re-check -> ONE provider
 *                      updateEvent. Outcomes:
 *                        confirmed  -> original: rescheduled (terminal),
 *                                      successor: booked (same event);
 *                        refused    -> original REVERTED to booked,
 *                                      successor rejected — the
 *                                      appointment stands, never moved
 *                                      silently;
 *                        ambiguous  -> BOTH sides verification_required
 *                                      (the event may be at either
 *                                       time); reconciliation resolves
 *                                      from the event's actual start.
 *
 * The invariant — never zero and never two live appointments — holds on
 * every path: exactly one of {original booked, successor booked} is live
 * afterward, or the pair is parked in verification_required for an
 * operator with the lineage recorded (reschedule_of + audit).
 */

const crypto = require('node:crypto');

const { readDomain } = require('../configuration/framework');
const { selectOfferedSlots } = require('./selection');
const { BookingContextStatus } = require('./booking-context-store');
const { CalendarWriteRejectedError, CalendarWriteUnverifiedError } = require('./calendar-provider');
const { generateCandidateSlots, resolveHoursForTarget } = require('./slot-generation');
const { localWindowUtc, MAX_OFFERED_TO_AGENT, MAX_RANKING_SLOTS, BOOKING_CONTEXT_TTL_MS } = require('./offered-slots');

/**
 * Offer reschedule slots for a booked native appointment.
 * @returns {Promise<{ kind: 'offered'|'no-availability'|'rejected',
 *   reason?: string, slots?: Array<object>,
 *   rescheduleContextId?: string|null, bookingContext?: string|null }>}
 */
async function offerReschedule({
  bookingContexts, calendarProviders = {}, configService, organizationKey,
  bookingContextId, request, clock, telemetry, correlationId,
}) {
  const original = await bookingContexts.get(bookingContextId);
  if (!original || original.organizationKey !== organizationKey) {
    return { kind: 'rejected', reason: 'booking_not_found' };
  }
  if (original.status !== BookingContextStatus.BOOKED) {
    return { kind: 'rejected', reason: 'booking_not_reschedulable' };
  }
  if (!original.providerKey) {
    return { kind: 'rejected', reason: 'reschedule_not_supported' };
  }
  const provider = calendarProviders[original.providerKey];
  if (!provider || !original.providerEventId || !original.calendarRef) {
    return { kind: 'rejected', reason: 'reschedule_not_configured' };
  }
  const { value: bookingWindow } = readDomain(configService, 'booking-window', organizationKey);
  if (original.selectedStartsAt
    && clock.now() + bookingWindow.rescheduleCutoffMinutes * 60_000 > Date.parse(original.selectedStartsAt)) {
    return { kind: 'rejected', reason: 'reschedule_cutoff' };
  }

  const organization = configService.organizations.get(organizationKey);
  const attributedAttorneyId = original.offeredTargets?.[original.selectedStartsAt]?.attorneyId
    ?? original.attorneyId ?? null;
  const hours = resolveHoursForTarget({
    attorneyId: attributedAttorneyId,
    attorneyHours: bookingWindow.attorneyHours,
    locations: configService.locations.list(organizationKey, {}),
    orgTimezone: organization.timezone,
  });
  if (hours.reason) return { kind: 'rejected', reason: 'availability_not_configured' };

  const { startUtcMs, endUtcMs } = localWindowUtc(request.dateFrom, request.dateTo, organization.timezone);
  const { intervals } = await provider.fetchBusyIntervals({
    calendarRef: original.calendarRef, startUtcMs, endUtcMs,
  });
  // The ORIGINAL appointment's own interval never blocks its reschedule.
  const originalStartMs = Date.parse(original.selectedStartsAt);
  const originalEndMs = originalStartMs + original.durationMinutes * 60_000;
  const busy = intervals.filter(
    (b) => !(Date.parse(b.startsAt) === originalStartMs && Date.parse(b.endsAt) === originalEndMs),
  );
  const nowMs = clock.now();
  const candidates = generateCandidateSlots({
    windows: hours.windows,
    timezone: hours.timezone,
    busyIntervals: busy,
    durationMinutes: original.durationMinutes,
    windowStartMs: startUtcMs,
    windowEndMs: endUtcMs,
    nowMs,
    policy: bookingWindow,
  }).filter((s) => Date.parse(s.startsAt) !== originalStartMs); // moving to the same time is not a move

  const ranked = selectOfferedSlots({
    configService,
    organizationKey,
    slots: candidates.map((s) => ({
      startsAt: s.startsAt,
      durationMinutes: original.durationMinutes,
      ...(attributedAttorneyId ? { attorneyId: attributedAttorneyId } : {}),
    })),
    request: { durationMinutes: original.durationMinutes },
    limit: MAX_OFFERED_TO_AGENT,
    maxSlots: MAX_RANKING_SLOTS,
    telemetry,
    correlationId,
  });
  const slots = ranked.slots.slice(0, MAX_OFFERED_TO_AGENT).map((s) => ({
    startsAt: s.startsAt,
    durationMinutes: s.durationMinutes,
    ...(s.attorneyId ? { attorneyId: s.attorneyId } : {}),
  }));
  if (slots.length === 0) return { kind: 'no-availability', slots: [] };

  const raw = `bct_${crypto.randomBytes(32).toString('base64url')}`;
  const offeredTargets = Object.fromEntries(slots.map((s) => [s.startsAt, {
    attorneyId: attributedAttorneyId, calendarRef: original.calendarRef,
  }]));
  const created = await bookingContexts.create({
    bookingContextId: `bc_${crypto.randomUUID()}`,
    contextTokenHash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
    organizationKey,
    sessionId: original.sessionId ?? null,
    routeKind: original.routeKind,
    attorneyId: original.attorneyId,
    routingGroupKey: original.routingGroupKey,
    practiceAreaId: original.practiceAreaId,
    consultationTypeId: original.consultationTypeId,
    eventTypeId: null,
    providerKey: original.providerKey,
    calendarRef: original.calendarRef,
    offeredTargets,
    rescheduleOf: original.bookingContextId,
    durationMinutes: original.durationMinutes,
    offeredSlots: slots.map((s) => s.startsAt),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + BOOKING_CONTEXT_TTL_MS,
  });
  return {
    kind: 'offered', slots,
    rescheduleContextId: created.bookingContextId, bookingContext: raw,
  };
}

/**
 * Confirm a reschedule: move the original event to the chosen offered
 * slot. See the module docstring for the full outcome matrix.
 * @returns {Promise<{ outcome: 'rescheduled'|'rejected'|'verification_required',
 *   reason?: string, startsAt?: string,
 *   bookingContextId: string, originalBookingContextId?: string }>}
 */
async function confirmReschedule({
  bookingContexts, calendarProviders = {}, organizationKey,
  rescheduleContextId, startsAt, clock, telemetry = null, correlationId, actor = 'caller-flow',
}) {
  const emit = (name, fields) => {
    if (telemetry) {
      telemetry.event(name, {
        severity: name === 'scheduling.booking_rescheduled' ? 'info' : 'warn',
        component: 'scheduling', operation: 'reschedule',
        organizationKey, correlationId, bookingContextId: rescheduleContextId, ...fields,
      });
    }
  };
  const rejected = (reason) => {
    emit('scheduling.reschedule_rejected', { code: reason });
    return { outcome: 'rejected', reason, bookingContextId: rescheduleContextId };
  };

  const successor = await bookingContexts.get(rescheduleContextId);
  if (!successor || successor.organizationKey !== organizationKey || !successor.rescheduleOf) {
    return rejected('reschedule_context_unknown');
  }
  if (successor.status === BookingContextStatus.EXPIRED) return rejected('reschedule_context_expired');
  if (successor.status !== BookingContextStatus.OFFERED) return rejected('reschedule_context_used');
  const requestedMs = Date.parse(startsAt);
  const canonicalStartsAt = successor.offeredSlots.find((s) => Date.parse(s) === requestedMs);
  if (!canonicalStartsAt) return rejected('timestamp_not_offered');
  const provider = calendarProviders[successor.providerKey];
  if (!provider) return rejected('reschedule_not_configured');

  // Claim the NEW instant first (the guard holds it), then take the
  // original out of 'booked' (it keeps holding the OLD instant).
  const claimed = await bookingContexts.claim({
    bookingContextId: successor.bookingContextId, startsAt: canonicalStartsAt,
  });
  if (!claimed) {
    const after = await bookingContexts.get(successor.bookingContextId);
    if (after && after.status === BookingContextStatus.OFFERED) return rejected('slot_no_longer_available');
    return rejected(after && after.status === BookingContextStatus.EXPIRED
      ? 'reschedule_context_expired' : 'reschedule_context_used');
  }
  const original = await bookingContexts.get(successor.rescheduleOf);
  const begun = original && original.organizationKey === organizationKey
    ? await bookingContexts.beginReschedule({ bookingContextId: original.bookingContextId, actor })
    : null;
  if (!begun) {
    // The original stopped being booked (cancelled / already moved):
    // the successor claim is released as a definitive rejection.
    await bookingContexts.complete({
      bookingContextId: successor.bookingContextId,
      status: BookingContextStatus.REJECTED,
      rejectionReason: 'reschedule_original_not_booked',
      actor,
    });
    return rejected('reschedule_original_not_booked');
  }

  const settle = async (originalStatus, successorStatus, reason, extra = {}) => {
    await bookingContexts.completeReschedule({
      bookingContextId: original.bookingContextId, status: originalStatus, rejectionReason: reason, actor,
    });
    await bookingContexts.complete({
      bookingContextId: successor.bookingContextId, status: successorStatus,
      rejectionReason: successorStatus === BookingContextStatus.BOOKED ? null : reason,
      actor,
      ...extra,
    });
  };

  // Busy re-check for the NEW interval, excluding the original's own.
  const newStartMs = Date.parse(canonicalStartsAt);
  const newEndMs = newStartMs + begun.durationMinutes * 60_000;
  const origStartMs = Date.parse(begun.selectedStartsAt);
  const origEndMs = origStartMs + begun.durationMinutes * 60_000;
  let recheck;
  try {
    recheck = await provider.fetchBusyIntervals({
      calendarRef: begun.calendarRef, startUtcMs: newStartMs, endUtcMs: newEndMs,
    });
  } catch {
    await settle(BookingContextStatus.BOOKED, BookingContextStatus.REJECTED, 'availability_recheck_failed');
    return rejected('availability_recheck_failed');
  }
  const conflicted = recheck.intervals.some((b) => {
    const bStart = Date.parse(b.startsAt);
    const bEnd = Date.parse(b.endsAt);
    if (bStart === origStartMs && bEnd === origEndMs) return false; // the event being moved
    return bStart < newEndMs && bEnd > newStartMs;
  });
  if (conflicted) {
    await settle(BookingContextStatus.BOOKED, BookingContextStatus.REJECTED, 'slot_no_longer_available');
    return rejected('slot_no_longer_available');
  }

  let moved;
  try {
    moved = await provider.updateEvent({
      calendarRef: begun.calendarRef,
      providerEventId: begun.providerEventId,
      correlationId: original.bookingContextId,
      startsAt: canonicalStartsAt,
      durationMinutes: begun.durationMinutes,
    });
  } catch (err) {
    if (err instanceof CalendarWriteRejectedError) {
      // Definitive refusal: the appointment STANDS at its original time.
      const reason = `reschedule_rejected_${err.detail}`;
      await settle(BookingContextStatus.BOOKED, BookingContextStatus.REJECTED, reason);
      return rejected(reason);
    }
    if (err instanceof CalendarWriteUnverifiedError) {
      // Ambiguous: the event may be at EITHER time. Both sides park in
      // verification_required; reconciliation reads the event's actual
      // start and resolves the pair.
      const reason = `reschedule_${err.detail}`;
      await settle(BookingContextStatus.VERIFICATION_REQUIRED, BookingContextStatus.VERIFICATION_REQUIRED, reason);
      emit('scheduling.booking_verification_required', { code: reason });
      return {
        outcome: 'verification_required', reason,
        bookingContextId: successor.bookingContextId,
        originalBookingContextId: original.bookingContextId,
      };
    }
    throw err; // unknown -> stale rescheduling/booking_in_progress reconcile loudly
  }

  // Confirmed. Persist BOTH sides; a persistence failure demotes to
  // verification_required rather than trusting process memory.
  try {
    await bookingContexts.completeReschedule({
      bookingContextId: original.bookingContextId, status: BookingContextStatus.RESCHEDULED, actor,
    });
    await bookingContexts.complete({
      bookingContextId: successor.bookingContextId, status: BookingContextStatus.BOOKED,
      providerEventId: begun.providerEventId,
      bookingResult: moved.sanitized,
      actor,
    });
  } catch {
    await bookingContexts.completeReschedule({
      bookingContextId: original.bookingContextId,
      status: BookingContextStatus.VERIFICATION_REQUIRED,
      rejectionReason: 'reschedule_result_persistence_failed',
      actor,
    }).catch(() => {});
    await bookingContexts.complete({
      bookingContextId: successor.bookingContextId,
      status: BookingContextStatus.VERIFICATION_REQUIRED,
      rejectionReason: 'reschedule_result_persistence_failed',
      actor,
    }).catch(() => {});
    emit('scheduling.booking_verification_required', { code: 'reschedule_result_persistence_failed' });
    return {
      outcome: 'verification_required', reason: 'reschedule_result_persistence_failed',
      bookingContextId: successor.bookingContextId,
      originalBookingContextId: original.bookingContextId,
    };
  }
  emit('scheduling.booking_rescheduled', {});
  return {
    outcome: 'rescheduled',
    startsAt: canonicalStartsAt,
    bookingContextId: successor.bookingContextId,
    originalBookingContextId: original.bookingContextId,
  };
}

module.exports = { offerReschedule, confirmReschedule };
