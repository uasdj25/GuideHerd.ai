'use strict';

/**
 * Consolidated offered-slots service — the platform's availability→offer
 * orchestration. The HTTP route authorizes, parses, invokes this
 * service, and maps the typed result; everything scheduling-shaped lives
 * here (validation, tenant window interpretation, provider fetch,
 * ranking via the existing ADR-0012 pipeline, telemetry).
 *
 * ── Window semantics (the GuideHerd contract) ─────────────────────────────
 * `dateFrom`/`dateTo` are INCLUSIVE calendar days in the ORGANIZATION'S
 * configured timezone. "2026-09-01".."2026-09-01" means the tenant-local
 * day September 1st, midnight to midnight — an evening slot that is
 * already September 2nd in UTC is still offered, and a slot that is
 * August 31st tenant-local is not, whatever its UTC date. Local-midnight
 * boundaries are computed per-day through Intl (DST-safe: on transition
 * days the local day is genuinely 23 or 25 hours long), then applied
 * BOTH to the provider query bounds and as a hard post-filter on what
 * the provider returned.
 *
 * ── Failure policy (approved) ─────────────────────────────────────────────
 * ESCALATION (typed error; the assistant offers no times) for: provider
 * timeout, network failure, provider HTTP 4xx/5xx, provider error
 * envelopes, malformed or oversized responses, missing provider or
 * tenant configuration, invalid requests, authorization failures, and
 * ANY unknown error — unknown exceptions propagate and fail closed;
 * nothing is caught broadly to "keep offering slots".
 * There is deliberately NO raw-slot fallback: no safe typed
 * ranking-only degradation exists today, so none is pretended. If one
 * is ever introduced it must satisfy: availability fetched AND validated
 * in the same execution, a narrowly TYPED transient ranking failure, and
 * business-hours/duration/tenant validation still enforced.
 *
 * Result kinds the conversation layer distinguishes:
 *   { kind: "offered", slots, window }          ranked, at most MAX_OFFERED_TO_AGENT
 *   { kind: "no-availability", slots: [], window }
 *   (everything else is a thrown typed error)
 */

const { ValidationError } = require('../handoff/errors');
const { selectOfferedSlots } = require('./selection');
const { resolveEventType, AvailabilityError } = require('./availability');

/** The assistant presents two options; it receives exactly what it presents. */
const MAX_OFFERED_TO_AGENT = 2;
/** Inclusive tenant-local calendar-day window bound. */
const MAX_WINDOW_DAYS = 31;
/** Ranking-input bound: a 31-day dense window fits well inside this, and
 *  ranking is measured in tens of milliseconds at this size. Oversized
 *  provider responses are rejected upstream — never truncated before
 *  ranking, which could discard a slot policy would rank first. */
const MAX_RANKING_SLOTS = 3000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_FIELDS = ['dateFrom', 'dateTo', 'attorneyId', 'consultationTypeId', 'durationMinutes', 'sessionId'];

/**
 * Validate the small offered-slots request. Optional context stays
 * optional — the assistant is never forced to fabricate an attorney,
 * consultation type, duration, or session id. Throws ValidationError
 * (400) listing every problem.
 */
function validateOfferedSlotsRequest(body) {
  const problems = [];
  const date = (name) => {
    const v = body[name];
    if (typeof v !== 'string' || !DATE_PATTERN.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
      problems.push({ field: name, message: 'must be a YYYY-MM-DD date' });
      return null;
    }
    return v;
  };
  const dateFrom = date('dateFrom');
  const dateTo = date('dateTo');
  if (dateFrom && dateTo) {
    const spanDays = (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000;
    if (spanDays < 0) problems.push({ field: 'dateTo', message: 'must not be before dateFrom' });
    else if (spanDays >= MAX_WINDOW_DAYS) {
      problems.push({ field: 'dateTo', message: `the window is capped at ${MAX_WINDOW_DAYS} days` });
    }
  }
  const optionalString = (name) => {
    const v = body[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.trim() === '') {
      problems.push({ field: name, message: 'must be a nonblank string when present' });
      return undefined;
    }
    return v.trim();
  };
  const attorneyId = optionalString('attorneyId');
  const consultationTypeId = optionalString('consultationTypeId');
  const sessionId = optionalString('sessionId');
  let durationMinutes;
  if (body.durationMinutes !== undefined && body.durationMinutes !== null) {
    if (!Number.isInteger(body.durationMinutes) || body.durationMinutes <= 0 || body.durationMinutes > 480) {
      problems.push({ field: 'durationMinutes', message: 'must be an integer between 1 and 480 when present' });
    } else {
      durationMinutes = body.durationMinutes;
    }
  }
  for (const k of Object.keys(body)) {
    if (!REQUEST_FIELDS.includes(k)) problems.push({ field: k, message: 'unknown field' });
  }
  if (problems.length > 0) throw new ValidationError('One or more fields are invalid.', problems);
  return { dateFrom, dateTo, attorneyId, consultationTypeId, durationMinutes, sessionId };
}

/** Timezone offset (localAsUTC - utc) at one instant, via Intl. */
function tzOffsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  return asUtc - utcMs;
}

/**
 * The UTC instant of local midnight opening a calendar day in a
 * timezone. Iterative offset resolution makes DST transitions exact —
 * never plain UTC-midnight arithmetic. An unknown timezone throws
 * (fail closed; tenant configuration is wrong).
 */
function localMidnightUtcMs(dateStr, timeZone) {
  let guess = Date.parse(`${dateStr}T00:00:00Z`);
  for (let i = 0; i < 3; i += 1) {
    const next = Date.parse(`${dateStr}T00:00:00Z`) - tzOffsetMs(guess, timeZone);
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

/** The calendar day after a YYYY-MM-DD string (pure date arithmetic). */
function nextCalendarDay(dateStr) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Inclusive tenant-local window -> half-open UTC instant range
 * [startUtcMs, endUtcMs): local midnight opening dateFrom through local
 * midnight opening the day AFTER dateTo.
 */
function localWindowUtc(dateFrom, dateTo, timeZone) {
  return {
    startUtcMs: localMidnightUtcMs(dateFrom, timeZone),
    endUtcMs: localMidnightUtcMs(nextCalendarDay(dateTo), timeZone),
  };
}

/**
 * One availability check: fetch -> map -> rank -> trim. Throws typed
 * errors per the failure policy above; never returns partial or unsafe
 * results.
 *
 * @returns {Promise<{ kind: 'offered'|'no-availability',
 *   slots: Array<{ startsAt: string, durationMinutes: number, attorneyId?: string }>,
 *   window: { dateFrom: string, dateTo: string },
 *   timings: { configMs: number, providerMs: number, providerHeadersMs: number,
 *              providerBodyMs: number, rankMs: number, totalMs: number },
 *   counts: { receivedCount: number, inWindowCount: number, offeredCount: number } }>}
 */
async function offerSlots({
  configService, availabilityProvider, organizationKey, request, telemetry, correlationId,
}) {
  const totalStarted = Date.now();

  // Tenant configuration (SQLite): timezone from the organization,
  // event types + duration from the calcom-availability domain.
  const organization = configService.organizations.get(organizationKey); // throws unknown_organization
  const { readDomain } = require('../configuration/framework');
  const { value: calcomConfig } = readDomain(configService, 'calcom-availability', organizationKey);
  const { eventTypeId, attributedAttorneyId } = resolveEventType(calcomConfig, request.attorneyId);
  const configMs = Date.now() - totalStarted;
  if (!eventTypeId) {
    const err = new AvailabilityError('availability_not_configured',
      'No availability event type is configured for this organization.');
    throw err;
  }

  // ONE bounded provider fetch over the tenant-local window.
  const { startUtcMs, endUtcMs } = localWindowUtc(request.dateFrom, request.dateTo, organization.timezone);
  const fetchStarted = Date.now();
  const fetched = await availabilityProvider.fetchAvailability({ eventTypeId, startUtcMs, endUtcMs });
  const providerMs = Date.now() - fetchStarted;

  // Map to the neutral contract; enforce the tenant-local window as a
  // hard post-filter regardless of what the provider chose to return.
  const durationMinutes = request.durationMinutes || calcomConfig.durationMinutes;
  const inWindow = fetched.slots.filter((s) => {
    const t = Date.parse(s.startsAt);
    return t >= startUtcMs && t < endUtcMs;
  });
  const mapped = inWindow.map((s) => ({
    startsAt: s.startsAt,
    durationMinutes,
    ...(attributedAttorneyId ? { attorneyId: attributedAttorneyId } : {}),
  }));

  // Rank the COMPLETE in-window set (no pre-ranking truncation — that
  // could discard a slot policy would rank first). Deterministic errors
  // from the pipeline propagate; there is no catch-all fallback.
  const rankStarted = Date.now();
  const ranked = selectOfferedSlots({
    configService,
    organizationKey,
    slots: mapped,
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

  // Model-facing minimum: the two presentable options, nothing internal,
  // null attribution omitted rather than serialized.
  const slots = ranked.slots.slice(0, MAX_OFFERED_TO_AGENT).map((s) => ({
    startsAt: s.startsAt,
    durationMinutes: s.durationMinutes,
    ...(s.attorneyId ? { attorneyId: s.attorneyId } : {}),
  }));

  return {
    kind: slots.length > 0 ? 'offered' : 'no-availability',
    slots,
    window: { dateFrom: request.dateFrom, dateTo: request.dateTo },
    timings: {
      configMs,
      providerMs,
      providerHeadersMs: fetched.timings ? fetched.timings.headersMs : undefined,
      providerBodyMs: fetched.timings ? fetched.timings.bodyMs : undefined,
      rankMs,
      totalMs: Date.now() - totalStarted,
    },
    counts: { receivedCount: fetched.slots.length, inWindowCount: inWindow.length, offeredCount: slots.length },
  };
}

module.exports = {
  offerSlots,
  validateOfferedSlotsRequest,
  localWindowUtc,
  localMidnightUtcMs,
  nextCalendarDay,
  MAX_OFFERED_TO_AGENT,
  MAX_WINDOW_DAYS,
  MAX_RANKING_SLOTS,
};
