'use strict';

/**
 * Microsoft Graph calendar provider (GitLab #84 discovery, #85
 * free/busy, #86 event lifecycle) — the first REAL implementation of the
 * Calendar Provider Contract (ADR-0024). One module because the
 * conformance suite certifies the contract as a whole.
 *
 * Everything here is implemented against DOCUMENTED Microsoft Graph
 * contracts and certified with the shared conformance suite over a
 * mocked transport; live behavior is deliberately unproven until #95
 * (the Microsoft support case gates it). No production-readiness claims.
 *
 * ── API surface used (documented contracts) ────────────────────────────
 *   Discovery (#84)   GET /v1.0/users?$select=id,displayName,mail,userPrincipalName
 *                     GET /v1.0/users/{mailbox}/calendar        (binding verification)
 *   Free/busy (#85)   POST /v1.0/users/{mailbox}/calendar/getSchedule
 *                     (schedules=[mailbox], UTC window, 62-day documented
 *                      limit — far above GuideHerd's 31-day cap)
 *   Events (#86)      POST   /v1.0/users/{mailbox}/events
 *                     GET    /v1.0/users/{mailbox}/events/{id}?$expand=…
 *                     PATCH  /v1.0/users/{mailbox}/events/{id}
 *                     DELETE /v1.0/users/{mailbox}/events/{id}
 *                     GET    /v1.0/users/{mailbox}/events?$filter=
 *                       singleValueExtendedProperties/Any(ep: …)
 *
 * ── Correlation (contract rule 3) ──────────────────────────────────────
 * Every created event carries the booking-context internal id in a
 * single-value extended property (a stable GUID namespace + name, below)
 * AND `transactionId`. Reconciliation (#87) finds events by the extended
 * property; mutation verifies it before touching anything.
 *
 * ── Idempotency investigation (the #86 written deliverable) ────────────
 * Microsoft DOES document an idempotency mechanism for event CREATION:
 * `transactionId` — "a custom identifier specified by a client app for
 * the server to avoid redundant POST operations in case of client
 * retries to create the same event" (Graph v1.0 event resource,
 * learn.microsoft.com/graph/api/resources/event). We SET it (the
 * booking-context id) on every create so a safe retry becomes possible
 * once live behavior is proven — but the adapter still performs exactly
 * ONE attempt per call: the documented mechanism is unproven on the
 * live tenant until #95, and the platform rule is no retry without
 * documented AND PROVEN idempotency. PATCH (update) is semantically
 * idempotent for absolute start/end values but has no documented retry
 * token; DELETE has none. Both stay single-attempt.
 *
 * ── Outcome classification (contract trichotomy) ───────────────────────
 *   Writes: 400/409 and other 4xx (except below) -> REJECTED
 *           (provider_rejected_<status>); 403/404 -> REJECTED
 *           (calendar_not_accessible / event_not_found); received 429 ->
 *           REJECTED provider_throttled (Microsoft documents throttled
 *           requests as NOT executed — a received 429 is definitive; the
 *           ambiguous throttle case is a TIMEOUT, which classifies
 *           ambiguous below); token-phase failures -> REJECTED
 *           auth_unavailable (no write was attempted);
 *           timeout / network / 5xx / unparseable-success -> UNVERIFIED
 *           (verification_required upstream).
 *   Reads:  any failure -> CalendarUnavailableError, FAIL CLOSED. One
 *           attempt; retry/backoff policy belongs to the caller.
 */

const {
  CalendarUnavailableError,
  CalendarWriteRejectedError,
  CalendarWriteUnverifiedError,
} = require('./calendar-provider');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
/** Stable extended-property namespace for the GuideHerd correlation id. */
const CORRELATION_PROPERTY_ID = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name GuideHerdBookingContextId';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_TIMEOUT_MS = 10_000;

/** Clamp the per-request budget into a sane bounded range. */
function clampGraphTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 250), MAX_TIMEOUT_MS);
}

const toIso = (value) => new Date(value).toISOString();
/** Graph dateTimeTimeZone body value: Z-less ISO with timeZone: 'UTC'. */
const graphUtc = (value) => ({ dateTime: toIso(value).slice(0, -1), timeZone: 'UTC' });
/** Graph dateTimeTimeZone -> UTC ISO instant (fail closed on nonsense). */
function graphDateTimeToIso(dt) {
  if (!dt || typeof dt.dateTime !== 'string') return null;
  const zone = (dt.timeZone || 'UTC').toUpperCase();
  const raw = dt.dateTime;
  // The adapter always REQUESTS UTC; anything else is unexpected shape.
  if (zone !== 'UTC') return null;
  const iso = raw.endsWith('Z') ? raw : `${raw}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : toIso(ms);
}

/** Busy classification policy (#85, tenant-neutral default, documented):
 *  busy / oof / tentative BLOCK; free / workingElsewhere do not. */
const BUSY_STATUSES = new Set(['busy', 'oof', 'tentative']);

function correlationOf(event) {
  const props = Array.isArray(event.singleValueExtendedProperties)
    ? event.singleValueExtendedProperties : [];
  const match = props.find((p) => p && p.id === CORRELATION_PROPERTY_ID);
  return match && typeof match.value === 'string' ? match.value : null;
}

function sanitizeGraphEvent(event) {
  const startsAt = graphDateTimeToIso(event.start);
  return {
    providerEventId: event.id,
    startsAt: startsAt ?? undefined,
    status: event.isCancelled ? 'cancelled' : 'confirmed',
  };
}

/**
 * @param {{ auth: ReturnType<typeof import('./msgraph-auth').createGraphCalendarAuth>,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} deps
 */
function createGraphCalendarProvider({ auth, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const budgetMs = clampGraphTimeoutMs(timeoutMs);

  /** One bounded Graph request. `write` selects the failure taxonomy;
   *  `notFoundDetail` says what a 404 MEANS in this call's URL shape
   *  (no event id in the URL -> the mailbox; an event id -> the event). */
  async function graphRequest({ method, path, body, write = false, select, notFoundDetail = 'calendar_not_accessible' }) {
    let token;
    try {
      token = await auth.getToken();
    } catch (err) {
      if (!write) throw err; // reads: fail closed with the auth error as-is
      // Token-phase failure means NO write was attempted — definitive.
      throw new CalendarWriteRejectedError(
        err && err.code === 'calendar_provider_not_configured' ? 'auth_not_configured' : 'auth_unavailable',
      );
    }
    let res;
    try {
      res = await fetchImpl(`${GRAPH_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(select ? { Prefer: 'outlook.timezone="UTC"' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(budgetMs),
      });
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (write) throw new CalendarWriteUnverifiedError(timeout ? 'provider_timeout' : 'network_failure');
      throw new CalendarUnavailableError(timeout ? 'provider_timeout' : 'network_failure');
    }
    if (res.status === 401) auth.invalidate(); // next call gets a fresh token
    if (!res.ok) {
      if (write) {
        if (res.status === 403) throw new CalendarWriteRejectedError('calendar_not_accessible');
        if (res.status === 404) throw new CalendarWriteRejectedError(notFoundDetail);
        // A RECEIVED 429 is definitive: Microsoft documents throttled
        // requests as not executed. (An ambiguous throttle is a timeout.)
        if (res.status === 429) throw new CalendarWriteRejectedError('provider_throttled');
        if (res.status >= 500) throw new CalendarWriteUnverifiedError(`provider_http_${res.status}`);
        throw new CalendarWriteRejectedError(`provider_rejected_${res.status}`);
      }
      if (res.status === 403) throw new CalendarUnavailableError('calendar_not_accessible');
      if (res.status === 404) throw new CalendarUnavailableError(notFoundDetail);
      if (res.status === 429) throw new CalendarUnavailableError('provider_throttled');
      throw new CalendarUnavailableError(`provider_http_${res.status}`);
    }
    if (res.status === 204) return null; // DELETE
    try {
      return await res.json();
    } catch {
      if (write) throw new CalendarWriteUnverifiedError('unparseable_success');
      throw new CalendarUnavailableError('malformed_response');
    }
  }

  /** Verify the stored correlation BEFORE any mutation (contract rule 4). */
  async function requireCorrelation({ calendarRef, providerEventId, correlationId, write = true }) {
    const event = await (async () => {
      try {
        return await graphRequest({
          method: 'GET',
          path: `/users/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(providerEventId)}`
            + `?$select=id,start,end,isCancelled&$expand=singleValueExtendedProperties`
            + `($filter=id eq '${CORRELATION_PROPERTY_ID}')`,
          select: true,
          notFoundDetail: 'event_not_found',
        });
      } catch (err) {
        if (write && err instanceof CalendarUnavailableError) {
          // The pre-mutation read failed: NOTHING was touched, so the
          // mutation is definitively not-applied — a rejection, never
          // ambiguity. 404/403 keep their meaning; transient trouble
          // becomes precheck_unavailable (safe to re-drive later).
          throw new CalendarWriteRejectedError(
            ['event_not_found', 'calendar_not_accessible'].includes(err.detail)
              ? err.detail : 'precheck_unavailable',
          );
        }
        throw err;
      }
    })();
    if (!event) throw new CalendarWriteRejectedError('event_not_found');
    if (correlationOf(event) !== correlationId) {
      throw new CalendarWriteRejectedError('correlation_mismatch');
    }
    return event;
  }

  return {
    key: 'msgraph',
    get configured() { return auth.configured; },

    /** #84 — discovery: schedulable mailboxes as calendar references. */
    async discoverCalendars() {
      const body = await graphRequest({
        method: 'GET',
        path: '/users?$select=id,displayName,mail,userPrincipalName&$top=999',
      });
      const users = Array.isArray(body && body.value) ? body.value : [];
      const results = [];
      for (const u of users) {
        if (!u || !(u.mail || u.userPrincipalName)) continue;
        const calendarRef = u.mail || u.userPrincipalName;
        // Calendars.ReadWrite is ONE application permission: a mailbox the
        // access policy admits is readable AND writable; one excluded is
        // neither. Never overclaim writability — verify per mailbox.
        const { accessible } = await this.verifyCalendarBinding({ calendarRef });
        results.push({
          calendarRef,
          displayName: u.displayName || calendarRef,
          capabilities: { read: accessible, write: accessible },
        });
      }
      return results;
    },

    /** #84 — binding verification: is this reference actually usable? */
    async verifyCalendarBinding({ calendarRef }) {
      try {
        const calendar = await graphRequest({
          method: 'GET',
          path: `/users/${encodeURIComponent(calendarRef)}/calendar?$select=id,name`,
        });
        return { calendarRef, accessible: Boolean(calendar && calendar.id), verifiedVia: 'calendar-read' };
      } catch (err) {
        if (err instanceof CalendarUnavailableError && err.detail === 'calendar_not_accessible') {
          return { calendarRef, accessible: false, verifiedVia: 'calendar-read' };
        }
        throw err; // transient trouble is NOT "inaccessible" — fail closed upstream
      }
    },

    /** #85 — free/busy translated to normalized busy intervals. */
    async fetchBusyIntervals({ calendarRef, startUtcMs, endUtcMs }) {
      const body = await graphRequest({
        method: 'POST',
        path: `/users/${encodeURIComponent(calendarRef)}/calendar/getSchedule`,
        select: true,
        body: {
          schedules: [calendarRef],
          startTime: graphUtc(startUtcMs),
          endTime: graphUtc(endUtcMs),
          availabilityViewInterval: 30,
        },
      });
      const schedule = body && Array.isArray(body.value) ? body.value[0] : null;
      if (!schedule) throw new CalendarUnavailableError('malformed_response');
      if (schedule.error) throw new CalendarUnavailableError('schedule_error');
      const items = Array.isArray(schedule.scheduleItems) ? schedule.scheduleItems : [];
      const intervals = [];
      for (const item of items) {
        const status = String(item.status || '').toLowerCase();
        if (!BUSY_STATUSES.has(status)) continue;
        const startsAt = graphDateTimeToIso(item.start);
        const endsAt = graphDateTimeToIso(item.end);
        // FAIL CLOSED: an unreadable interval is not skippable — skipping
        // could offer time that is actually busy.
        if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) {
          throw new CalendarUnavailableError('malformed_response');
        }
        intervals.push({ startsAt, endsAt });
      }
      intervals.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
        || Date.parse(a.endsAt) - Date.parse(b.endsAt));
      return { intervals };
    },

    /** #86 — event creation with durable correlation + transactionId. */
    async createEvent({ calendarRef, startsAt, durationMinutes, summary, attendee, correlationId }) {
      if (typeof correlationId !== 'string' || correlationId.trim() === '') {
        throw new CalendarWriteRejectedError('missing_correlation');
      }
      const startIso = toIso(startsAt);
      const endIso = toIso(Date.parse(startsAt) + durationMinutes * 60_000);
      const event = await graphRequest({
        method: 'POST',
        path: `/users/${encodeURIComponent(calendarRef)}/events`,
        write: true,
        select: true,
        notFoundDetail: 'calendar_not_accessible',
        body: {
          subject: typeof summary === 'string' ? summary : 'Consultation',
          start: graphUtc(startIso),
          end: graphUtc(endIso),
          // Whether Graph notifies attendees is TENANT POLICY (#88); the
          // adapter records the attendee for the attorney's own calendar
          // entry without inventing a meeting request when none is wanted.
          ...(attendee && attendee.email ? {
            attendees: [{
              type: 'required',
              emailAddress: { address: attendee.email, ...(attendee.name ? { name: attendee.name } : {}) },
            }],
          } : {}),
          transactionId: correlationId.trim(),
          singleValueExtendedProperties: [
            { id: CORRELATION_PROPERTY_ID, value: correlationId.trim() },
          ],
        },
      });
      if (!event || typeof event.id !== 'string') {
        throw new CalendarWriteUnverifiedError('missing_event_id');
      }
      return { providerEventId: event.id, sanitized: sanitizeGraphEvent(event) };
    },

    /** #86 — correlation-verified update (move). */
    async updateEvent({ calendarRef, providerEventId, correlationId, startsAt, durationMinutes }) {
      const current = await requireCorrelation({ calendarRef, providerEventId, correlationId });
      const patch = {};
      if (startsAt !== undefined) {
        patch.start = graphUtc(startsAt);
        const currentStart = graphDateTimeToIso(current.start);
        const currentEnd = graphDateTimeToIso(current.end);
        const inferred = currentStart && currentEnd
          ? Math.round((Date.parse(currentEnd) - Date.parse(currentStart)) / 60_000)
          : 0;
        const duration = durationMinutes ?? (inferred > 0 ? inferred : 30);
        patch.end = graphUtc(Date.parse(startsAt) + duration * 60_000);
      }
      const updated = await graphRequest({
        method: 'PATCH',
        path: `/users/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(providerEventId)}`,
        write: true,
        select: true,
        notFoundDetail: 'event_not_found',
        body: patch,
      });
      if (!updated || typeof updated.id !== 'string') {
        throw new CalendarWriteUnverifiedError('missing_event_id');
      }
      return { providerEventId: updated.id, sanitized: sanitizeGraphEvent(updated) };
    },

    /** #86 — correlation-verified cancel (delete). */
    async cancelEvent({ calendarRef, providerEventId, correlationId }) {
      const current = await requireCorrelation({ calendarRef, providerEventId, correlationId });
      await graphRequest({
        method: 'DELETE',
        path: `/users/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(providerEventId)}`,
        write: true,
        notFoundDetail: 'event_not_found',
      });
      return { sanitized: { ...sanitizeGraphEvent(current), status: 'cancelled' } };
    },

    /** #87 — reconciliation read: locate an event by correlation alone. */
    async findEventByCorrelation({ calendarRef, correlationId }) {
      const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${CORRELATION_PROPERTY_ID}' `
        + `and ep/value eq '${String(correlationId).replace(/'/g, "''")}')`;
      const body = await graphRequest({
        method: 'GET',
        path: `/users/${encodeURIComponent(calendarRef)}/events`
          + `?$filter=${encodeURIComponent(filter)}&$select=id,start,end,isCancelled`
          + `&$expand=singleValueExtendedProperties($filter=id eq '${CORRELATION_PROPERTY_ID}')`,
        select: true,
      });
      const events = body && Array.isArray(body.value) ? body.value : [];
      const match = events.find((e) => correlationOf(e) === correlationId);
      return match ? sanitizeGraphEvent(match) : null;
    },
  };
}

module.exports = {
  createGraphCalendarProvider,
  clampGraphTimeoutMs,
  CORRELATION_PROPERTY_ID,
  BUSY_STATUSES,
};
