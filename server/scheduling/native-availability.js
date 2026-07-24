'use strict';

/**
 * The provider-neutral native availability service (GitLab #79) —
 * GuideHerd's own answer to "what should we offer?", computed from
 * provider busy intervals instead of provider-shaped slot feeds.
 *
 * Orchestration per availability check:
 *
 *   1. resolve ONE scheduling target set server-side (#76 — fail-closed
 *      precedence; zero provider calls on an unresolved route);
 *   2. resolve the hours every target generates from (#78 — attorney
 *      override or the sole hours-bearing location; absent/ambiguous
 *      hours FAIL CLOSED);
 *   3. ONE bounded busy-interval read per resolved target (a
 *      routing-group pool reads each member; ANY failed read fails the
 *      whole check closed — a pool never silently shrinks to whoever
 *      happened to answer);
 *   4. generate candidate slots per target (#78) with per-target
 *      attribution;
 *   5. merge pool candidates with DETERMINISTIC balanced attribution:
 *      one attorney per offered start, chosen by fewest assignments so
 *      far, ties by attorney key — the attributed attorney IS the
 *      attorney the booking lands on (#80 books the attributed
 *      calendar, never re-chooses);
 *   6. rank through the existing ADR-0012 pipeline (policy stays the
 *      ranking authority) and cap at the conversation-facing maximum.
 *
 * The language model transports NOTHING new: request and response
 * schemas are the deployed offered-slots contract; raw busy intervals
 * and full candidate sets never leave the server.
 */

const { readDomain } = require('../configuration/framework');
const { selectOfferedSlots } = require('./selection');
const { AvailabilityError } = require('./availability');
const { resolveSchedulingTarget, resolveAppointmentDuration } = require('./scheduling-targets');
const { generateCandidateSlots, resolveHoursForTarget } = require('./slot-generation');
const { localWindowUtc, MAX_OFFERED_TO_AGENT, MAX_RANKING_SLOTS } = require('./offered-slots');

/**
 * Merge per-target candidate slots into one chronological offer set with
 * exactly one attributed target per start time. Deterministic: fewest
 * assignments wins, ties break on attorney key, then calendar ref.
 */
function mergeCandidatesBalanced(perTarget) {
  const byStart = new Map();
  for (const { target, slots } of perTarget) {
    for (const slot of slots) {
      if (!byStart.has(slot.startsAt)) byStart.set(slot.startsAt, []);
      byStart.get(slot.startsAt).push(target);
    }
  }
  const starts = [...byStart.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  const assignments = new Map();
  const merged = [];
  for (const startsAt of starts) {
    const candidates = [...byStart.get(startsAt)].sort((a, b) => {
      const countDiff = (assignments.get(a.attorneyId ?? '') || 0) - (assignments.get(b.attorneyId ?? '') || 0);
      if (countDiff !== 0) return countDiff;
      const keyA = a.attorneyId ?? '';
      const keyB = b.attorneyId ?? '';
      return keyA < keyB ? -1 : (keyA > keyB ? 1 : (a.calendarRef < b.calendarRef ? -1 : 1));
    });
    const chosen = candidates[0];
    assignments.set(chosen.attorneyId ?? '', (assignments.get(chosen.attorneyId ?? '') || 0) + 1);
    merged.push({ startsAt, attorneyId: chosen.attorneyId, calendarRef: chosen.calendarRef });
  }
  return merged;
}

/**
 * Compute the native offer for one availability check. Pure orchestration
 * over injected dependencies; throws the same typed error families the
 * deployed service throws (routing_unresolved / availability_not_configured
 * / provider read failures) — the HTTP layer's mapping is unchanged.
 *
 * @param {{
 *   configService: object,
 *   calendarProvider: object,        ADR-0024 contract implementation
 *   organizationKey: string,
 *   request: ReturnType<typeof validateOfferedSlotsRequest>,
 *   nowMs: number,
 *   telemetry?: { event: Function },
 *   correlationId?: string,
 * }} args
 * @returns {Promise<{ kind: 'offered'|'no-availability',
 *   slots: Array<{ startsAt: string, durationMinutes: number, attorneyId?: string }>,
 *   window: { dateFrom: string, dateTo: string },
 *   route: object, durationMinutes: number,
 *   offeredTargets: Record<string, { attorneyId: string|null, calendarRef: string }>,
 *   counts: { candidateCount: number, offeredCount: number },
 *   timings: { configMs: number, providerMs: number, rankMs: number, totalMs: number } }>}
 */
async function computeNativeAvailability({
  configService, calendarProvider, organizationKey, request, nowMs, telemetry, correlationId,
}) {
  const totalStarted = Date.now();
  const organization = configService.organizations.get(organizationKey);
  const { value: targetsConfig } = readDomain(configService, 'calendar-targets', organizationKey);
  const { value: bookingWindow } = readDomain(configService, 'booking-window', organizationKey);
  if (!targetsConfig.provider) {
    throw new AvailabilityError('availability_not_configured',
      'Native scheduling is not configured for this organization.');
  }
  const route = resolveSchedulingTarget({
    config: targetsConfig,
    attorneyId: request.attorneyId ?? null,
    practiceAreaId: request.practiceAreaId ?? null,
    routingGroups: request.practiceAreaId ? configService.routingGroups.list(organizationKey) : [],
  });
  const durationMinutes = request.durationMinutes
    || resolveAppointmentDuration(targetsConfig, request.consultationTypeId ?? null);
  const locations = configService.locations.list(organizationKey, {});
  const { startUtcMs, endUtcMs } = localWindowUtc(request.dateFrom, request.dateTo, organization.timezone);
  const configMs = Date.now() - totalStarted;

  // Hours per target — resolved BEFORE any provider call so a
  // misconfigured tenant never spends provider budget.
  const targetPlans = route.targets.map((target) => {
    const hours = resolveHoursForTarget({
      attorneyId: target.attorneyId,
      attorneyHours: bookingWindow.attorneyHours,
      locations,
      orgTimezone: organization.timezone,
    });
    if (hours.reason) {
      throw new AvailabilityError('availability_not_configured',
        `No usable business hours for scheduling (${hours.reason}).`);
    }
    return { target, hours };
  });

  // One bounded busy read per target, in parallel. Any failure fails the
  // WHOLE check closed — partial pools are never offered.
  const providerStarted = Date.now();
  const perTarget = await Promise.all(targetPlans.map(async ({ target, hours }) => {
    const { intervals } = await calendarProvider.fetchBusyIntervals({
      calendarRef: target.calendarRef, startUtcMs, endUtcMs,
    });
    const slots = generateCandidateSlots({
      windows: hours.windows,
      timezone: hours.timezone,
      busyIntervals: intervals,
      durationMinutes,
      windowStartMs: startUtcMs,
      windowEndMs: endUtcMs,
      nowMs,
      policy: bookingWindow,
    });
    return { target, slots };
  }));
  const providerMs = Date.now() - providerStarted;

  const merged = mergeCandidatesBalanced(perTarget);

  // Rank through the ADR-0012 pipeline — policy remains the ranking
  // authority; the attributed attorney rides along for scoring and the
  // conversation-facing response.
  const rankStarted = Date.now();
  const ranked = selectOfferedSlots({
    configService,
    organizationKey,
    slots: merged.map((m) => ({
      startsAt: m.startsAt,
      durationMinutes,
      ...(m.attorneyId ? { attorneyId: m.attorneyId } : {}),
    })),
    request: {
      ...(request.attorneyId ? { attorneyId: request.attorneyId } : {}),
      ...(request.consultationTypeId ? { consultationTypeId: request.consultationTypeId } : {}),
      durationMinutes,
    },
    limit: MAX_OFFERED_TO_AGENT,
    maxSlots: MAX_RANKING_SLOTS,
    telemetry,
    correlationId,
    sessionId: request.sessionId,
  });
  const rankMs = Date.now() - rankStarted;

  const slots = ranked.slots.slice(0, MAX_OFFERED_TO_AGENT).map((s) => ({
    startsAt: s.startsAt,
    durationMinutes: s.durationMinutes,
    ...(s.attorneyId ? { attorneyId: s.attorneyId } : {}),
  }));
  // The exact target each OFFERED start books into — persisted with the
  // booking context (#80) so booking lands on the attributed calendar by
  // construction.
  const attributionByStart = new Map(merged.map((m) => [m.startsAt, m]));
  const offeredTargets = {};
  for (const slot of slots) {
    const m = attributionByStart.get(slot.startsAt);
    offeredTargets[slot.startsAt] = { attorneyId: m.attorneyId ?? null, calendarRef: m.calendarRef };
  }

  return {
    kind: slots.length > 0 ? 'offered' : 'no-availability',
    slots,
    window: { dateFrom: request.dateFrom, dateTo: request.dateTo },
    route,
    durationMinutes,
    offeredTargets,
    counts: { candidateCount: merged.length, offeredCount: slots.length },
    timings: { configMs, providerMs, rankMs, totalMs: Date.now() - totalStarted },
  };
}

/** The tenant's native calendar provider key, or null (legacy path). */
function nativeProviderKeyFor(configService, organizationKey) {
  const { value } = readDomain(configService, 'calendar-targets', organizationKey);
  return value.provider;
}

/**
 * The NATIVE offered-slots service (GitLab #79/#80): compute the offer,
 * then issue the durable booking context recording the resolved targets
 * — the exact shape the deployed legacy service returns, so the HTTP
 * route and the conversation layer see no difference.
 */
async function offerNativeSlots({
  configService, calendarProviders = {}, bookingContexts = null, clock = null,
  organizationKey, request, telemetry, correlationId,
}) {
  const crypto = require('node:crypto');
  const { AvailabilityError: AvailErr } = require('./availability');
  const providerKey = nativeProviderKeyFor(configService, organizationKey);
  const calendarProvider = calendarProviders[providerKey];
  if (!calendarProvider) {
    // A selected-but-unregistered provider FAILS CLOSED as configuration.
    throw new AvailErr('availability_not_configured',
      'The selected native calendar provider is not available on this deployment.');
  }
  const nowMs = clock ? clock.now() : Date.now();
  const offer = await computeNativeAvailability({
    configService, calendarProvider, organizationKey, request, nowMs, telemetry, correlationId,
  });

  let bookingContext = null;
  let bookingContextId = null;
  if (offer.slots.length > 0 && bookingContexts) {
    const raw = `bct_${crypto.randomBytes(32).toString('base64url')}`;
    const singleTarget = offer.route.targets.length === 1 ? offer.route.targets[0].calendarRef : null;
    const created = await bookingContexts.create({
      bookingContextId: `bc_${crypto.randomUUID()}`,
      contextTokenHash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
      organizationKey,
      sessionId: request.sessionId ?? null,
      routeKind: offer.route.routeKind,
      attorneyId: offer.route.attorneyId,
      routingGroupKey: offer.route.routingGroupKey,
      practiceAreaId: offer.route.practiceAreaId,
      consultationTypeId: request.consultationTypeId ?? null,
      eventTypeId: null,
      providerKey,
      calendarRef: singleTarget,
      offeredTargets: offer.offeredTargets,
      durationMinutes: offer.durationMinutes,
      offeredSlots: offer.slots.map((s) => s.startsAt),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + require('./offered-slots').BOOKING_CONTEXT_TTL_MS,
    });
    bookingContext = raw;
    bookingContextId = created.bookingContextId;
  }

  return {
    kind: offer.kind,
    slots: offer.slots,
    window: offer.window,
    routeKind: offer.route.routeKind,
    bookingContext,
    bookingContextId,
    timings: offer.timings,
    counts: {
      receivedCount: offer.counts.candidateCount,
      inWindowCount: offer.counts.candidateCount,
      offeredCount: offer.counts.offeredCount,
    },
  };
}

module.exports = {
  computeNativeAvailability,
  mergeCandidatesBalanced,
  offerNativeSlots,
  nativeProviderKeyFor,
};
