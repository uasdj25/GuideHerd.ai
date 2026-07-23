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
      const url = `${baseUrl}/slots?eventTypeId=${encodeURIComponent(eventTypeId)}`
        + `&startTime=${encodeURIComponent(new Date(startUtcMs).toISOString())}`
        + `&endTime=${encodeURIComponent(new Date(endUtcMs).toISOString())}`;
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
 *     "eventTypeId": <real Cal.com event type id>,     // org-wide
 *     "attorneyEventTypes": { "<attorneyKey>": <id> }, // optional per-attorney
 *     "durationMinutes": 30                            // appointment length
 *   }
 */
function normalizeCalcomAvailabilityConfig(raw) {
  const empty = { eventTypeId: null, attorneyEventTypes: {}, durationMinutes: 30 };
  if (raw === null || raw === undefined) return { value: empty, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: empty, issues: ['must be an object like { "eventTypeId": <id>, "durationMinutes": 30 }'] };
  }
  const issues = [];
  for (const k of Object.keys(raw)) {
    if (!['eventTypeId', 'attorneyEventTypes', 'durationMinutes'].includes(k)) issues.push(`unknown field: ${k}`);
  }
  let eventTypeId = null;
  if (raw.eventTypeId !== undefined && raw.eventTypeId !== null) {
    if (Number.isInteger(raw.eventTypeId) && raw.eventTypeId > 0) eventTypeId = raw.eventTypeId;
    else issues.push('eventTypeId must be a positive integer');
  }
  const attorneyEventTypes = {};
  if (raw.attorneyEventTypes !== undefined) {
    if (typeof raw.attorneyEventTypes !== 'object' || raw.attorneyEventTypes === null || Array.isArray(raw.attorneyEventTypes)) {
      issues.push('attorneyEventTypes must map attorney keys to event type ids');
    } else {
      for (const [attorney, id] of Object.entries(raw.attorneyEventTypes)) {
        if (typeof attorney !== 'string' || attorney.trim() === '') {
          issues.push('attorneyEventTypes keys must be nonblank attorney keys');
        } else if (!Number.isInteger(id) || id <= 0) {
          issues.push(`attorneyEventTypes.${attorney} must be a positive integer event type id`);
        } else {
          attorneyEventTypes[attorney.trim()] = id;
        }
      }
    }
  }
  let durationMinutes = 30;
  if (raw.durationMinutes !== undefined) {
    if (Number.isInteger(raw.durationMinutes) && raw.durationMinutes > 0 && raw.durationMinutes <= 480) {
      durationMinutes = raw.durationMinutes;
    } else {
      issues.push('durationMinutes must be an integer between 1 and 480');
    }
  }
  return { value: { eventTypeId, attorneyEventTypes, durationMinutes }, issues };
}

/**
 * Resolve which event type one availability check should query.
 * A mapped attorney uses THAT attorney's event type (slots are then
 * attributable to them); otherwise the org-wide event type is queried and
 * slots stay unattributed — attribution is never fabricated.
 *
 * BOOKING CONSISTENCY: the event type resolved here MUST be the same
 * event type the conversation layer's booking tool creates against; see
 * docs/api/offered-slots.md ("Booking consistency") — availability from
 * one calendar must never be booked into another.
 * @returns {{ eventTypeId: number|null, attributedAttorneyId: string|null }}
 */
function resolveEventType(config, attorneyId) {
  if (attorneyId && config.attorneyEventTypes[attorneyId]) {
    return { eventTypeId: config.attorneyEventTypes[attorneyId], attributedAttorneyId: attorneyId };
  }
  return { eventTypeId: config.eventTypeId, attributedAttorneyId: null };
}

module.exports = {
  createCalcomAvailabilityProvider,
  normalizeCalcomAvailabilityConfig,
  resolveEventType,
  parseCalcomSlots,
  clampTimeoutMs,
  AvailabilityError,
  AvailabilityNotConfiguredError,
  AvailabilityTimeoutError,
  AvailabilityProviderError,
  AvailabilityMalformedError,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_PROVIDER_SLOTS,
};
