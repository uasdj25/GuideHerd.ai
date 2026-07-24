'use strict';

/**
 * The Calendar Provider Contract (ADR-0024 / GitLab #75) — the ONE
 * boundary through which GuideHerd's native Scheduling Core uses an
 * external calendar service.
 *
 * Scheduling Core owns all business behavior (routing, policy, slot
 * generation, ranking, booking lifecycle, audit); a calendar provider
 * only TRANSLATES: it discovers calendars, retrieves busy intervals,
 * creates/updates/cancels events, and retrieves the provider state
 * reconciliation needs — mapping its service's dialect into the
 * normalized shapes below. A provider never sees a routing decision,
 * never ranks, never owns tenant rules. Adding a provider (Microsoft
 * Graph first; Google Workspace later) must require ZERO Core changes:
 * implement this contract and pass the conformance suite
 * (calendar-provider-contract-suite.js) — that suite is the
 * certification bar.
 *
 * ── Normalized shapes ──────────────────────────────────────────────────
 *
 *   Calendar reference   an opaque provider-scoped string. Core stores
 *                        and transports it; only the provider interprets
 *                        it. Discovery entry:
 *                          { calendarRef, displayName,
 *                            capabilities: { read, write } }
 *
 *   Busy interval        { startsAt, endsAt } — ISO-8601 UTC instants,
 *                        endsAt strictly after startsAt, sorted by
 *                        startsAt. Whether tentative/out-of-office marks
 *                        count as busy is decided INSIDE the provider by
 *                        its documented policy; Core sees busy or free,
 *                        nothing else.
 *
 *   Sanitized event      { providerEventId, startsAt, status } — the
 *                        small persistable subset. NEVER the raw provider
 *                        payload, never attendee data echoed back.
 *
 * ── Outcome classification (the trichotomy) ────────────────────────────
 *
 * Every state-changing operation resolves exactly one way:
 *   CONFIRMED   the provider positively confirmed the change — return
 *               value with a providerEventId;
 *   REJECTED    the provider (or a contract rule) definitively refused —
 *               CalendarWriteRejectedError; nothing changed;
 *   AMBIGUOUS   the change may or may not have happened (timeout,
 *               connection loss, 5xx, unparseable success, missing id) —
 *               CalendarWriteUnverifiedError. The caller maps this to
 *               verification_required; it is NEVER guessed either way.
 *
 * ── Contract rules ─────────────────────────────────────────────────────
 *
 *  1. Adapters NEVER retry — not writes (a retry after ambiguity risks a
 *     double booking; no provider retry is permitted without documented,
 *     proven idempotency) and not reads (retry/backoff policy belongs to
 *     the CALLER, which owns the latency budget). One call, one
 *     transport attempt.
 *  2. Reads FAIL CLOSED: a timeout, provider error, or unparseable
 *     response is CalendarUnavailableError — partial availability is
 *     never presented as complete, and free time is never guessed.
 *  3. Every created event durably carries the caller's `correlationId`
 *     (the booking-context internal id — an internal identifier, never
 *     the opaque context value, never PII). Reconciliation finds events
 *     by correlation, never by attendee identity, never by same-time
 *     inference.
 *  4. Mutation requires correlation: updateEvent/cancelEvent verify the
 *     stored correlation matches before touching anything; a mismatch is
 *     a definitive rejection (`correlation_mismatch`) with no mutation.
 *  5. Timeouts are bounded and owned by the adapter's construction-time
 *     budget (the caller clamps them); no socket defaults.
 *  6. No secrets, tokens, raw provider payloads, or attendee PII in any
 *     error message, sanitized result, or telemetry field.
 *
 * The reference provider below implements the full contract in memory:
 * it is the deterministic fake for Core tests AND the proof that Core is
 * provider-blind. Created events feed back into busy intervals, so
 * end-to-end native flows (offer → book → re-check) exercise realistic
 * calendar state without any network.
 */

class CalendarProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CalendarProviderError';
    this.code = code;
  }
}

class CalendarProviderNotConfiguredError extends CalendarProviderError {
  constructor() {
    super('calendar_provider_not_configured', 'The calendar provider is not configured.');
  }
}

/**
 * A READ failed (availability, discovery, reconciliation lookup).
 * FAIL CLOSED: the caller must not offer slots or infer state.
 * `detail` is a small enum for telemetry: provider_timeout,
 * network_failure, provider_http_<status>, malformed_response,
 * calendar_not_accessible.
 */
class CalendarUnavailableError extends CalendarProviderError {
  constructor(detail) {
    super('calendar_unavailable', `The calendar provider could not be read (${detail}).`);
    this.detail = detail;
  }
}

/** A DEFINITIVE refusal of a state-changing operation; nothing changed. */
class CalendarWriteRejectedError extends CalendarProviderError {
  /** @param {string} detail small enum: provider_rejected_<status>,
   *  calendar_not_accessible, event_not_found, correlation_mismatch,
   *  missing_correlation */
  constructor(detail) {
    super('calendar_write_rejected', `The calendar provider rejected the operation (${detail}).`);
    this.detail = detail;
  }
}

/**
 * An AMBIGUOUS state-changing outcome: the operation may or may not have
 * taken effect (timeout, connection loss, provider 5xx, unparseable
 * success, missing event id). Never retried, never guessed — the caller
 * maps this to verification_required and reconciliation resolves it from
 * provider evidence.
 */
class CalendarWriteUnverifiedError extends CalendarProviderError {
  /** @param {string} detail small enum: provider_timeout, network_failure,
   *  provider_http_<status>, unparseable_success, missing_event_id */
  constructor(detail) {
    super('calendar_write_unverified', `The calendar operation outcome could not be verified (${detail}).`);
    this.detail = detail;
  }
}

/** The operations every calendar provider must implement. */
const CALENDAR_PROVIDER_OPERATIONS = Object.freeze([
  'discoverCalendars',
  'fetchBusyIntervals',
  'createEvent',
  'updateEvent',
  'cancelEvent',
  'findEventByCorrelation',
]);

/** Structural check used by composition roots and the conformance suite. */
function isCalendarProvider(candidate) {
  return Boolean(candidate)
    && typeof candidate.key === 'string'
    && typeof candidate.configured === 'boolean'
    && CALENDAR_PROVIDER_OPERATIONS.every((op) => typeof candidate[op] === 'function');
}

const toIso = (value) => new Date(value).toISOString();

/** Sanitized persistable subset of a stored event. */
function sanitizeEvent(event) {
  return {
    providerEventId: event.providerEventId,
    startsAt: event.startsAt,
    status: event.status,
  };
}

/**
 * The in-memory reference calendar provider — the contract's executable
 * specification. Deterministic, injectable-clock, no IO. Also exposes the
 * conformance-harness surface (givenCalendar / injectFailure / attempts /
 * eventsOn) that a real provider's test harness must mirror around its
 * mocked transport.
 *
 * Fault kinds for injectFailure(operation, kind), one-shot per call:
 *   'timeout' | 'network' | 'http_500' | 'unparseable'  -> reads: fail
 *     closed; writes: ambiguous (unverified);
 *   'reject'            -> definitive provider rejection;
 *   'ambiguous_created' -> createEvent only: the event IS stored, then
 *     the response is "lost" (unverified) — the reconciliation case.
 */
function createReferenceCalendarProvider({ key = 'reference' } = {}) {
  /** @type {Map<string, { displayName: string, writable: boolean,
   *   busy: Array<{ startsAt: string, endsAt: string }>,
   *   events: Map<string, object> }>} */
  const calendars = new Map();
  const injected = new Map(); // operation -> kind (one-shot)
  const attemptCounts = new Map(); // operation -> transport attempts
  let nextEventId = 1;

  const attempt = (operation) => {
    attemptCounts.set(operation, (attemptCounts.get(operation) || 0) + 1);
  };
  const takeInjected = (operation) => {
    const kind = injected.get(operation);
    if (kind) injected.delete(operation);
    return kind || null;
  };
  const readFailure = (kind) => {
    if (kind === 'timeout') return new CalendarUnavailableError('provider_timeout');
    if (kind === 'network') return new CalendarUnavailableError('network_failure');
    if (kind === 'http_500') return new CalendarUnavailableError('provider_http_500');
    return new CalendarUnavailableError('malformed_response');
  };
  const writeFailure = (kind) => {
    if (kind === 'reject') return new CalendarWriteRejectedError('provider_rejected_400');
    if (kind === 'timeout') return new CalendarWriteUnverifiedError('provider_timeout');
    if (kind === 'network') return new CalendarWriteUnverifiedError('network_failure');
    if (kind === 'http_500') return new CalendarWriteUnverifiedError('provider_http_500');
    return new CalendarWriteUnverifiedError('unparseable_success');
  };
  const requireCalendar = (calendarRef, { forWrite = false } = {}) => {
    const calendar = calendars.get(calendarRef);
    if (!calendar) {
      throw forWrite
        ? new CalendarWriteRejectedError('calendar_not_accessible')
        : new CalendarUnavailableError('calendar_not_accessible');
    }
    if (forWrite && !calendar.writable) {
      throw new CalendarWriteRejectedError('calendar_not_accessible');
    }
    return calendar;
  };
  const overlaps = (startsAtMs, endsAtMs, fromMs, toMs) => startsAtMs < toMs && endsAtMs > fromMs;

  return {
    key,
    configured: true,

    // ── Conformance-harness surface (test/composition use only) ──
    givenCalendar(calendarRef, { displayName = calendarRef, writable = true, busy = [] } = {}) {
      calendars.set(calendarRef, {
        displayName,
        writable,
        busy: busy.map((b) => ({ startsAt: toIso(b.startsAt), endsAt: toIso(b.endsAt) })),
        events: new Map(),
      });
    },
    injectFailure(operation, kind) {
      injected.set(operation, kind);
    },
    attempts(operation) {
      return attemptCounts.get(operation) || 0;
    },
    eventsOn(calendarRef) {
      const calendar = calendars.get(calendarRef);
      return calendar ? [...calendar.events.values()].map((e) => ({ ...e })) : [];
    },

    // ── Contract operations ──
    async discoverCalendars() {
      attempt('discoverCalendars');
      const kind = takeInjected('discoverCalendars');
      if (kind) throw readFailure(kind);
      return [...calendars.entries()].map(([calendarRef, c]) => ({
        calendarRef,
        displayName: c.displayName,
        capabilities: { read: true, write: c.writable },
      }));
    },

    async fetchBusyIntervals({ calendarRef, startUtcMs, endUtcMs }) {
      attempt('fetchBusyIntervals');
      const kind = takeInjected('fetchBusyIntervals');
      if (kind) throw readFailure(kind);
      const calendar = requireCalendar(calendarRef);
      const intervals = [];
      for (const b of calendar.busy) {
        if (overlaps(Date.parse(b.startsAt), Date.parse(b.endsAt), startUtcMs, endUtcMs)) {
          intervals.push({ startsAt: b.startsAt, endsAt: b.endsAt });
        }
      }
      for (const event of calendar.events.values()) {
        if (event.status === 'cancelled') continue;
        const startMs = Date.parse(event.startsAt);
        const endMs = startMs + event.durationMinutes * 60_000;
        if (overlaps(startMs, endMs, startUtcMs, endUtcMs)) {
          intervals.push({ startsAt: event.startsAt, endsAt: toIso(endMs) });
        }
      }
      intervals.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
        || Date.parse(a.endsAt) - Date.parse(b.endsAt));
      return { intervals };
    },

    async createEvent({ calendarRef, startsAt, durationMinutes, summary, correlationId }) {
      attempt('createEvent');
      const kind = takeInjected('createEvent');
      if (kind && kind !== 'ambiguous_created') throw writeFailure(kind);
      if (typeof correlationId !== 'string' || correlationId.trim() === '') {
        // Contract rule 3: a create without correlation is unreconcilable
        // and is refused before anything is written.
        throw new CalendarWriteRejectedError('missing_correlation');
      }
      const calendar = requireCalendar(calendarRef, { forWrite: true });
      const providerEventId = `ref-evt-${nextEventId += 1}`;
      const event = {
        providerEventId,
        startsAt: toIso(startsAt),
        durationMinutes,
        summary: typeof summary === 'string' ? summary : '',
        correlationId: correlationId.trim(),
        status: 'confirmed',
      };
      calendar.events.set(providerEventId, event);
      if (kind === 'ambiguous_created') throw writeFailure('timeout');
      return { providerEventId, sanitized: sanitizeEvent(event) };
    },

    async updateEvent({ calendarRef, providerEventId, correlationId, startsAt, durationMinutes }) {
      attempt('updateEvent');
      const kind = takeInjected('updateEvent');
      if (kind) throw writeFailure(kind);
      const calendar = requireCalendar(calendarRef, { forWrite: true });
      const event = calendar.events.get(providerEventId);
      if (!event) throw new CalendarWriteRejectedError('event_not_found');
      if (event.correlationId !== correlationId) {
        throw new CalendarWriteRejectedError('correlation_mismatch');
      }
      if (startsAt !== undefined) event.startsAt = toIso(startsAt);
      if (durationMinutes !== undefined) event.durationMinutes = durationMinutes;
      return { providerEventId, sanitized: sanitizeEvent(event) };
    },

    async cancelEvent({ calendarRef, providerEventId, correlationId }) {
      attempt('cancelEvent');
      const kind = takeInjected('cancelEvent');
      if (kind) throw writeFailure(kind);
      const calendar = requireCalendar(calendarRef, { forWrite: true });
      const event = calendar.events.get(providerEventId);
      if (!event) throw new CalendarWriteRejectedError('event_not_found');
      if (event.correlationId !== correlationId) {
        throw new CalendarWriteRejectedError('correlation_mismatch');
      }
      event.status = 'cancelled';
      return { sanitized: sanitizeEvent(event) };
    },

    async findEventByCorrelation({ calendarRef, correlationId, startUtcMs, endUtcMs }) {
      attempt('findEventByCorrelation');
      const kind = takeInjected('findEventByCorrelation');
      if (kind) throw readFailure(kind);
      const calendar = requireCalendar(calendarRef);
      for (const event of calendar.events.values()) {
        if (event.correlationId !== correlationId) continue;
        if (startUtcMs !== undefined && endUtcMs !== undefined) {
          const startMs = Date.parse(event.startsAt);
          const endMs = startMs + event.durationMinutes * 60_000;
          if (!overlaps(startMs, endMs, startUtcMs, endUtcMs)) continue;
        }
        return sanitizeEvent(event);
      }
      return null; // absence is an answer, never an error
    },
  };
}

module.exports = {
  createReferenceCalendarProvider,
  isCalendarProvider,
  sanitizeEvent,
  CALENDAR_PROVIDER_OPERATIONS,
  CalendarProviderError,
  CalendarProviderNotConfiguredError,
  CalendarUnavailableError,
  CalendarWriteRejectedError,
  CalendarWriteUnverifiedError,
};
