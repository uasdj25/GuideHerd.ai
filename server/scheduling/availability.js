'use strict';

/**
 * Server-side Cal.com availability — the platform's availability source
 * for the consolidated offered-slots flow.
 *
 * Availability moves server-to-server in ONE bounded request; the
 * conversation layer's language model never transports slot batches
 * (that model-mediated transport is what produced minutes of caller-
 * facing token generation and a silent policy bypass in voice testing —
 * the Issue #66 latency defect this capability resolves).
 *
 * Interactive-voice discipline, non-negotiable:
 *   - ONE request per availability check (no per-day or per-attorney
 *     fan-out);
 *   - a HARD total timeout via AbortController — configurable, clamped
 *     to an interactive maximum, never a socket default;
 *   - NO automatic retries — a retry doubles what the caller waits;
 *   - typed failures (timeout / provider error / malformed / not
 *     configured) so the caller can fail closed per policy.
 *
 * Parsing FAILS CLOSED: unknown shapes, provider error envelopes served
 * with HTTP 200, missing or malformed timestamps, and oversized
 * responses are all typed failures — availability is never guessed.
 * Duplicate timestamps are deduplicated deterministically (first
 * occurrence wins) before anything downstream sees them.
 *
 * The provider returns NEUTRAL slots ({ startsAt }) — attribution and
 * ranking belong to the caller. Credentials come from the environment
 * (CALCOM_API_KEY), never from the Configuration Store, and are never
 * logged.
 */

const DEFAULT_BASE_URL = 'https://api.cal.com/v2';
const DEFAULT_TIMEOUT_MS = 1200;
/** Interactive ceiling: the endpoint budget is ~1.5 s; a configured
 *  provider timeout may never exceed it. */
const MAX_TIMEOUT_MS = 1500;
const CAL_API_VERSION = '2024-09-04';
/** A month-long window at dense half-hour granularity is ~1,500 slots;
 *  beyond twice that, the response is not believable availability. */
const MAX_PROVIDER_SLOTS = 3000;

class AvailabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AvailabilityError';
    this.code = code;
  }
}

class AvailabilityNotConfiguredError extends AvailabilityError {
  constructor() {
    super('availability_not_configured', 'The availability provider is not configured.');
  }
}

class AvailabilityTimeoutError extends AvailabilityError {
  constructor(timeoutMs) {
    super('availability_timeout', `The availability provider did not answer within ${timeoutMs} ms.`);
    this.timeoutMs = timeoutMs;
  }
}

class AvailabilityProviderError extends AvailabilityError {
  /** @param {number} httpStatus the provider's HTTP status (0 = network failure, no HTTP exchange) */
  constructor(httpStatus) {
    super('availability_provider_error', `The availability provider answered HTTP ${httpStatus}.`);
    this.httpStatus = httpStatus;
  }
}

class AvailabilityMalformedError extends AvailabilityError {
  constructor(detail = 'unrecognized response shape') {
    super('availability_malformed', `The availability provider returned an unusable response: ${detail}.`);
  }
}

/**
 * The established caller context cannot be routed to a configured Cal.com
 * event type — coverage or configuration is missing, or the routing is
 * ambiguous. FAIL CLOSED: the assistant apologizes, offers no times, and
 * escalates; nothing ever guesses a calendar. `reason` is a small enum for
 * telemetry (attorney_unmapped, attorney_not_permitted, no_routing_group,
 * ambiguous_routing_group, routing_group_unmapped).
 */
class RoutingUnresolvedError extends AvailabilityError {
  constructor(reason, message) {
    super('routing_unresolved', message);
    this.reason = reason;
  }
}

/**
 * Parse a Cal.com slots response into neutral `{ startsAt }` entries —
 * chronologically sorted, deterministically deduplicated.
 *
 * Documented shapes accepted (see docs/api/offered-slots.md):
 *   v2 (cal-api-version 2024-09-04):
 *     { "data": { "YYYY-MM-DD": [ { "start": "ISO" } ] }, "status": "success" }
 *   v1 legacy:
 *     { "slots": { "YYYY-MM-DD": [ { "time": "ISO" } ] } }
 * Entry variants `{ start }`, `{ time }`, and bare ISO strings parse;
 * anything else fails closed. A provider ERROR ENVELOPE served with
 * HTTP 200 ({ status: "error" } / { error: … }) is a provider error,
 * never silently empty availability.
 */
function parseCalcomSlots(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AvailabilityMalformedError();
  }
  if (body.status === 'error' || (body.error !== undefined && body.error !== null)) {
    throw new AvailabilityProviderError(200);
  }
  const byDate = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data
    : (body.slots && typeof body.slots === 'object' && !Array.isArray(body.slots) ? body.slots : null);
  if (!byDate) throw new AvailabilityMalformedError();

  const seen = new Set();
  const slots = [];
  for (const entries of Object.values(byDate)) {
    if (!Array.isArray(entries)) throw new AvailabilityMalformedError();
    for (const entry of entries) {
      const iso = typeof entry === 'string' ? entry
        : (entry && typeof entry === 'object' ? (entry.start ?? entry.time) : null);
      if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) {
        throw new AvailabilityMalformedError('missing or malformed timestamp');
      }
      if (seen.has(iso)) continue; // duplicates collapse; first occurrence wins
      seen.add(iso);
      slots.push({ startsAt: iso });
      if (slots.length > MAX_PROVIDER_SLOTS) {
        throw new AvailabilityMalformedError(`more than ${MAX_PROVIDER_SLOTS} slots`);
      }
    }
  }
  slots.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return slots;
}

/** Clamp a configured timeout into the interactive-voice range. */
function clampTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 100), MAX_TIMEOUT_MS);
}

/**
 * @param {{
 *   apiKey?: string|null,        CALCOM_API_KEY; absent -> not-configured on use
 *   baseUrl?: string,
 *   timeoutMs?: number,          hard total budget; clamped to [100, 1500] ms
 *   fetchImpl?: typeof fetch,    injectable for tests
 * }} [options]
 * @returns {{ key: string, timeoutMs: number,
 *             fetchAvailability: (args: { eventTypeId: number, startUtcMs: number, endUtcMs: number })
 *               => Promise<{ slots: Array<{ startsAt: string }>,
 *                            timings: { headersMs: number, bodyMs: number } }> }}
 */
function createCalcomAvailabilityProvider({
  apiKey = null, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch,
} = {}) {
  const budgetMs = clampTimeoutMs(timeoutMs);
  return {
    key: 'calcom',
    timeoutMs: budgetMs,

    /**
     * ONE bounded request for the window. The caller supplies exact UTC
     * instants (tenant-local calendar-day bounds are computed upstream —
     * this client does no timezone interpretation of its own).
     * Timings separate response-header arrival from body completion;
     * finer phases (DNS, TCP, TLS) are not observable through fetch and
     * are deliberately not guessed at.
     */
    async fetchAvailability({ eventTypeId, startUtcMs, endUtcMs }) {
      if (!apiKey) throw new AvailabilityNotConfiguredError();
      // cal-api-version 2024-09-04 names the range `start`/`end` (the
      // older `startTime`/`endTime` names are rejected with HTTP 400 —
      // verified against the live API during Gate 9 deployment checks).
      const url = `${baseUrl}/slots?eventTypeId=${encodeURIComponent(eventTypeId)}`
        + `&start=${encodeURIComponent(new Date(startUtcMs).toISOString())}`
        + `&end=${encodeURIComponent(new Date(endUtcMs).toISOString())}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      const started = Date.now();
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'cal-api-version': CAL_API_VERSION,
            accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw new AvailabilityTimeoutError(budgetMs);
        throw new AvailabilityProviderError(0); // network failure: no HTTP exchange
      }
      const headersMs = Date.now() - started;
      let body;
      try {
        if (!response.ok) throw new AvailabilityProviderError(response.status);
        try {
          body = await response.json();
        } catch (err) {
          if (err && err.name === 'AbortError') throw new AvailabilityTimeoutError(budgetMs);
          throw new AvailabilityMalformedError('non-JSON body');
        }
      } finally {
        clearTimeout(timer);
      }
      const bodyMs = Date.now() - started - headersMs;
      return { slots: parseCalcomSlots(body), timings: { headersMs, bodyMs } };
    },
  };
}

/**
 * Normalize the `scheduling/calcom-availability` settings document (the
 * domain's registered validator, ADR-0016). LENIENT reads; consumers
 * decide that a missing event type is fatal — provisioning FAILS CLOSED
 * until a real event type is configured. No placeholder is ever shipped.
 *
 *   {
 *     "eventTypeId": <real Cal.com event type id>,         // explicit default path
 *     "attorneyEventTypes": { "<attorneyKey>": <id> },     // optional per-attorney
 *     "routingGroupEventTypes": { "<groupKey>": <id> },    // optional per routing group
 *     "durationMinutes": 30                                // appointment length
 *   }
 *
 * `eventTypeId` is the EXPLICITLY configured default path: its presence is
 * the tenant's permission for no-context availability checks; removing it
 * disables that path. Attorney and routing-group maps serve the resolved
 * routes (see resolveBookingRoute).
 */
function normalizeCalcomAvailabilityConfig(raw) {
  const empty = {
    eventTypeId: null, attorneyEventTypes: {}, routingGroupEventTypes: {}, durationMinutes: 30,
  };
  if (raw === null || raw === undefined) return { value: empty, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: empty, issues: ['must be an object like { "eventTypeId": <id>, "durationMinutes": 30 }'] };
  }
  const issues = [];
  for (const k of Object.keys(raw)) {
    if (!['eventTypeId', 'attorneyEventTypes', 'routingGroupEventTypes', 'durationMinutes'].includes(k)) {
      issues.push(`unknown field: ${k}`);
    }
  }
  let eventTypeId = null;
  if (raw.eventTypeId !== undefined && raw.eventTypeId !== null) {
    // SAFE integers only: an id beyond 2^53-1 cannot round-trip JSON/JS
    // exactly, and a silently-shifted event type books the wrong calendar.
    if (Number.isSafeInteger(raw.eventTypeId) && raw.eventTypeId > 0) eventTypeId = raw.eventTypeId;
    else issues.push('eventTypeId must be a positive safe integer');
  }
  /** Shared shape for the two key→event-type maps. */
  const eventTypeMap = (field, keyNoun) => {
    const map = {};
    if (raw[field] === undefined) return map;
    if (typeof raw[field] !== 'object' || raw[field] === null || Array.isArray(raw[field])) {
      issues.push(`${field} must map ${keyNoun} keys to event type ids`);
      return map;
    }
    for (const [key, id] of Object.entries(raw[field])) {
      if (typeof key !== 'string' || key.trim() === '') {
        issues.push(`${field} keys must be nonblank ${keyNoun} keys`);
      } else if (!Number.isSafeInteger(id) || id <= 0) {
        issues.push(`${field}.${key} must be a positive safe integer event type id`);
      } else {
        map[key.trim()] = id;
      }
    }
    return map;
  };
  const attorneyEventTypes = eventTypeMap('attorneyEventTypes', 'attorney');
  const routingGroupEventTypes = eventTypeMap('routingGroupEventTypes', 'routing-group');
  let durationMinutes = 30;
  if (raw.durationMinutes !== undefined) {
    if (Number.isInteger(raw.durationMinutes) && raw.durationMinutes > 0 && raw.durationMinutes <= 480) {
      durationMinutes = raw.durationMinutes;
    } else {
      issues.push('durationMinutes must be an integer between 1 and 480');
    }
  }
  return { value: { eventTypeId, attorneyEventTypes, routingGroupEventTypes, durationMinutes }, issues };
}

/**
 * Resolve the ONE routing decision an availability check and its
 * subsequent booking share. The resolved route is persisted in the
 * durable booking context; booking reads the event type from that row —
 * availability from one calendar can never be booked into another BY
 * CONSTRUCTION (the conversation layer transports only an opaque value).
 *
 * Precedence (every miss FAILS CLOSED — nothing ever guesses a calendar):
 *
 *  1. attorney + practice area — the attorney override is honored only
 *     when the attorney is a member of the single active routing group
 *     configured for that practice area AND has an attorneyEventTypes
 *     mapping. Membership-as-eligibility is the Martinson & Beason
 *     tenant's configured policy for this demo, NOT a universal platform
 *     assumption: a future explicit provider-to-service-area eligibility
 *     model can replace this check without changing the booking-context
 *     contract (the persisted route shape is unchanged).
 *  2. attorney only — that attorney's attorneyEventTypes mapping.
 *  3. practice area only — exactly one active routing group for the
 *     area, mapped through routingGroupEventTypes. The group's calendar
 *     (e.g. a Cal.com round-robin event) assigns the host; slots stay
 *     unattributed — attribution is never fabricated.
 *  4. neither — the org-wide eventTypeId, ONLY because its presence is
 *     the tenant's explicit permission for the default path.
 *
 * Inputs are catalog-validated upstream (unknown/inactive keys are 400s
 * before resolution runs).
 *
 * @param {{
 *   config: { eventTypeId: number|null,
 *             attorneyEventTypes: Record<string, number>,
 *             routingGroupEventTypes: Record<string, number> },
 *   attorneyId?: string|null,
 *   practiceAreaId?: string|null,
 *   routingGroups?: Array<{ key: string, serviceArea: string,
 *                           providers: string[], active?: boolean }>,
 * }} args
 * @returns {{ routeKind: 'attorney'|'routing-group'|'default',
 *             eventTypeId: number,
 *             attorneyId: string|null, routingGroupKey: string|null,
 *             practiceAreaId: string|null,
 *             attributedAttorneyId: string|null }}
 * @throws {RoutingUnresolvedError|AvailabilityError} fail closed
 */
function resolveBookingRoute({ config, attorneyId = null, practiceAreaId = null, routingGroups = [] }) {
  const singleActiveGroupFor = (areaKey) => {
    const groups = routingGroups.filter((g) => g.active !== false && g.serviceArea === areaKey);
    if (groups.length === 0) {
      throw new RoutingUnresolvedError('no_routing_group',
        `No active routing group serves practice area "${areaKey}".`);
    }
    if (groups.length > 1) {
      throw new RoutingUnresolvedError('ambiguous_routing_group',
        `More than one active routing group serves practice area "${areaKey}".`);
    }
    return groups[0];
  };
  const attorneyRoute = (withArea) => {
    const eventTypeId = config.attorneyEventTypes[attorneyId];
    if (!eventTypeId) {
      throw new RoutingUnresolvedError('attorney_unmapped',
        `Attorney "${attorneyId}" has no configured availability event type.`);
    }
    return {
      routeKind: 'attorney', eventTypeId, attorneyId,
      routingGroupKey: null, practiceAreaId: withArea ? practiceAreaId : null,
      attributedAttorneyId: attorneyId,
    };
  };

  if (attorneyId && practiceAreaId) {
    const group = singleActiveGroupFor(practiceAreaId);
    if (!Array.isArray(group.providers) || !group.providers.includes(attorneyId)) {
      throw new RoutingUnresolvedError('attorney_not_permitted',
        `Attorney "${attorneyId}" is not configured for practice area "${practiceAreaId}".`);
    }
    return attorneyRoute(true);
  }
  if (attorneyId) return attorneyRoute(false);
  if (practiceAreaId) {
    const group = singleActiveGroupFor(practiceAreaId);
    const eventTypeId = config.routingGroupEventTypes[group.key];
    if (!eventTypeId) {
      throw new RoutingUnresolvedError('routing_group_unmapped',
        `Routing group "${group.key}" has no configured availability event type.`);
    }
    return {
      routeKind: 'routing-group', eventTypeId, attorneyId: null,
      routingGroupKey: group.key, practiceAreaId, attributedAttorneyId: null,
    };
  }
  if (config.eventTypeId) {
    return {
      routeKind: 'default', eventTypeId: config.eventTypeId, attorneyId: null,
      routingGroupKey: null, practiceAreaId: null, attributedAttorneyId: null,
    };
  }
  // The default path is not permitted (no explicit eventTypeId).
  throw new AvailabilityError('availability_not_configured',
    'No availability event type is configured for this organization.');
}

module.exports = {
  createCalcomAvailabilityProvider,
  normalizeCalcomAvailabilityConfig,
  resolveBookingRoute,
  parseCalcomSlots,
  clampTimeoutMs,
  AvailabilityError,
  AvailabilityNotConfiguredError,
  AvailabilityTimeoutError,
  AvailabilityProviderError,
  AvailabilityMalformedError,
  RoutingUnresolvedError,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_PROVIDER_SLOTS,
};
