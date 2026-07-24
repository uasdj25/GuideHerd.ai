'use strict';

/**
 * Server-side Cal.com booking — the booking half of the consolidated
 * scheduling flow. The offered-slots service persists ONE routing
 * decision (the booking context); this module books strictly within it:
 * the event type, duration, and permissible timestamps all come from the
 * durable context row, never from the conversation layer.
 *
 * Discipline (mirrors availability.js, adjusted for a terminal action):
 *   - ONE request per booking attempt;
 *   - NO automatic retries — current official Cal.com V2 documentation
 *     provides NO idempotency mechanism for POST /v2/bookings (verified
 *     2026-07-22), so a retry after an ambiguous failure risks a double
 *     booking;
 *   - a HARD timeout via AbortController (default 2500 ms, clamped to
 *     5000 ms — booking tolerates more latency than the availability
 *     path, but the caller is still on the line);
 *   - AMBIGUITY IS NEVER RESOLVED BY GUESSING: a timeout, connection
 *     loss, provider 5xx, or unparseable success is verification_required
 *     — the caller is never told "booked" and never told "not booked";
 *     an operator verifies against Cal.com using the CONTEXT ROW's own
 *     fields (event type, selected timestamp, booking_context_id) and
 *     matches candidates by metadata.guideherdBookingContextId — never
 *     by attendee identity, which this table deliberately does not hold
 *     (see docs/api/booking.md, "Reconciliation procedure").
 *
 * Correlation without PII: the request carries the booking-context id in
 * Cal.com's caller-supplied `metadata` (documented: ≤50 keys, keys ≤40
 * chars, string values ≤500 chars) so an operator can tie a Cal.com
 * booking back to its context. Attendee details pass through to Cal.com
 * and are never persisted in booking_contexts.
 *
 * cal-api-version 2024-08-13: the version the tenant's live, working
 * Create Booking integration sends today (read back from the deployed
 * tool during the Gate 10 inspection) — proven against the live API by
 * real bookings. Current docs advertise newer versions; adopting one is
 * a deliberate migration, not a default.
 */

const { ValidationError } = require('../handoff/errors');
const { BookingContextStatus } = require('./booking-context-store');
const {
  CalendarWriteRejectedError,
  CalendarWriteUnverifiedError,
} = require('./calendar-provider');

const DEFAULT_BASE_URL = 'https://api.cal.com/v2';
const DEFAULT_BOOKING_TIMEOUT_MS = 2500;
const MAX_BOOKING_TIMEOUT_MS = 5000;
const BOOKING_CAL_API_VERSION = '2024-08-13';

class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}

class BookingNotConfiguredError extends BookingError {
  constructor() {
    super('booking_not_configured', 'The booking provider is not configured.');
  }
}

/** A DEFINITIVE provider rejection: Cal.com answered and said no. */
class BookingRejectedByProviderError extends BookingError {
  /** @param {number} httpStatus provider HTTP status (200 = error envelope) */
  constructor(httpStatus) {
    super('booking_provider_rejected', `The booking provider rejected the request with HTTP ${httpStatus}.`);
    this.httpStatus = httpStatus;
  }
}

/**
 * An AMBIGUOUS outcome: the request may or may not have created a
 * booking (timeout, connection loss, provider 5xx, unparseable success).
 * Never claimed as success OR failure — verification_required.
 */
class BookingUnverifiedError extends BookingError {
  /** @param {string} detail small enum for telemetry/reconciliation */
  constructor(detail) {
    super('booking_unverified', `The booking outcome could not be verified (${detail}).`);
    this.detail = detail;
  }
}

/** Clamp a configured booking timeout into its interactive range. */
function clampBookingTimeoutMs(value, fallback = DEFAULT_BOOKING_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 100), MAX_BOOKING_TIMEOUT_MS);
}

/**
 * @param {{ apiKey?: string|null, baseUrl?: string, timeoutMs?: number,
 *           fetchImpl?: typeof fetch }} [options]
 */
function createCalcomBookingProvider({
  apiKey = null, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_BOOKING_TIMEOUT_MS, fetchImpl = fetch,
} = {}) {
  const budgetMs = clampBookingTimeoutMs(timeoutMs);
  return {
    key: 'calcom',
    timeoutMs: budgetMs,
    configured: Boolean(apiKey),

    /**
     * ONE bounded booking request. Returns `{ uid, sanitized }` on a
     * CONFIRMED success; throws typed errors otherwise. `sanitized` is
     * the small persistable subset (uid/start/status) — never the raw
     * provider payload, never attendee data.
     */
    async createBooking({ eventTypeId, startsAt, attendee, metadata }) {
      if (!apiKey) throw new BookingNotConfiguredError();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/bookings`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'cal-api-version': BOOKING_CAL_API_VERSION,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            start: startsAt,
            eventTypeId,
            attendee,
            ...(metadata ? { metadata } : {}),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // The request may already have reached Cal.com: fetch cannot say
        // whether a timeout or connection loss struck before or after
        // transmission. AMBIGUOUS — never retried, never guessed.
        if (err && err.name === 'AbortError') throw new BookingUnverifiedError('provider_timeout');
        throw new BookingUnverifiedError('network_failure');
      }
      let body;
      try {
        if (!response.ok) {
          // 4xx: Cal.com understood and refused — definitively NOT booked.
          // 5xx: the provider failed mid-request; the booking may exist.
          if (response.status >= 400 && response.status < 500) {
            throw new BookingRejectedByProviderError(response.status);
          }
          throw new BookingUnverifiedError(`provider_http_${response.status}`);
        }
        try {
          body = await response.json();
        } catch {
          // HTTP success with an unreadable body: probably created.
          throw new BookingUnverifiedError('unparseable_success_body');
        }
      } finally {
        clearTimeout(timer);
      }
      if (body && body.status === 'error') throw new BookingRejectedByProviderError(200);
      const data = body && typeof body === 'object' ? body.data : null;
      const uid = data && typeof data === 'object' && typeof data.uid === 'string' ? data.uid : null;
      if (!uid) {
        // 2xx without a recognizable confirmation: treat as ambiguous.
        throw new BookingUnverifiedError('missing_booking_uid');
      }
      return {
        uid,
        sanitized: {
          uid,
          start: typeof data.start === 'string' ? data.start : startsAt,
          ...(typeof data.status === 'string' ? { status: data.status } : {}),
        },
      };
    },
  };
}

const ATTENDEE_FIELDS = ['name', 'email', 'phoneNumber'];
const REQUEST_FIELDS = ['bookingContext', 'startsAt', 'attendee', 'sessionId'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the booking request. The conversation layer supplies ONLY the
 * opaque context value, the chosen timestamp, and attendee contact
 * details — there is no event-type-, route-, or duration-shaped input to
 * validate because none is accepted. Throws ValidationError (400).
 */
function validateBookingRequest(body) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('One or more fields are invalid.', [{ field: '(body)', message: 'must be a JSON object' }]);
  }
  for (const k of Object.keys(body)) {
    if (!REQUEST_FIELDS.includes(k)) problems.push({ field: k, message: 'unknown field' });
  }
  const bookingContext = typeof body.bookingContext === 'string' && body.bookingContext.trim() !== '' && body.bookingContext.length <= 512
    ? body.bookingContext.trim() : null;
  if (!bookingContext) problems.push({ field: 'bookingContext', message: 'must be the opaque booking context from the offered-slots response' });
  const startsAt = typeof body.startsAt === 'string' && !Number.isNaN(Date.parse(body.startsAt))
    ? body.startsAt.trim() : null;
  if (!startsAt) problems.push({ field: 'startsAt', message: 'must be an ISO 8601 timestamp from the offered slots' });
  let attendee = null;
  if (!body.attendee || typeof body.attendee !== 'object' || Array.isArray(body.attendee)) {
    problems.push({ field: 'attendee', message: 'must be an object with name and email' });
  } else {
    for (const k of Object.keys(body.attendee)) {
      if (!ATTENDEE_FIELDS.includes(k)) problems.push({ field: `attendee.${k}`, message: 'unknown field' });
    }
    const name = typeof body.attendee.name === 'string' && body.attendee.name.trim() !== '' && body.attendee.name.length <= 200
      ? body.attendee.name.trim() : null;
    if (!name) problems.push({ field: 'attendee.name', message: 'must be a nonblank string of at most 200 characters' });
    const email = typeof body.attendee.email === 'string' && body.attendee.email.length <= 254 && EMAIL_PATTERN.test(body.attendee.email.trim())
      ? body.attendee.email.trim() : null;
    if (!email) problems.push({ field: 'attendee.email', message: 'must be an email address' });
    let phoneNumber;
    if (body.attendee.phoneNumber !== undefined && body.attendee.phoneNumber !== null) {
      if (typeof body.attendee.phoneNumber !== 'string' || body.attendee.phoneNumber.trim() === '' || body.attendee.phoneNumber.length > 32) {
        problems.push({ field: 'attendee.phoneNumber', message: 'must be a nonblank string of at most 32 characters when present' });
      } else {
        phoneNumber = body.attendee.phoneNumber.trim();
      }
    }
    if (name && email) attendee = { name, email, ...(phoneNumber ? { phoneNumber } : {}) };
  }
  let sessionId;
  if (body.sessionId !== undefined && body.sessionId !== null) {
    if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
      problems.push({ field: 'sessionId', message: 'must be a nonblank string when present' });
    } else {
      sessionId = body.sessionId.trim();
    }
  }
  if (problems.length > 0) throw new ValidationError('One or more fields are invalid.', problems);
  return { bookingContext, startsAt, attendee, sessionId };
}

/**
 * Book one appointment inside a governed booking context.
 *
 * Order of operations (an invalid request NEVER consumes the context):
 *   1. resolve the context by token hash within the tenant;
 *   2. classify non-claimable states (expired / used) without side effects;
 *   3. verify the requested timestamp is one of the offered timestamps;
 *   4. CLAIM (atomic single-use: offered -> booking_in_progress);
 *   5. ONE provider request;
 *   6. persist the outcome, then — and only then — report it.
 *
 * "booked" is reported ONLY after Cal.com confirms AND the booked row is
 * durably committed. A confirmed booking whose persistence fails is
 * verification_required — success is never claimed on memory alone.
 *
 * @returns {Promise<{ outcome: 'booked'|'rejected'|'expired'|'verification_required',
 *   reason?: string, httpStatus?: number,
 *   bookingContextId: string|null, routeKind?: string, sessionId?: string|null,
 *   startsAt?: string, durationMinutes?: number, attorneyId?: string,
 *   calcomBookingUid?: string, timings: { providerMs: number, totalMs: number } }>}
 */
async function bookAppointment({
  bookingContexts, bookingProvider, calendarProviders = {}, configService, organizationKey, request, clock,
}) {
  const totalStarted = Date.now();
  const finish = (result, providerMs = 0) => ({
    ...result,
    timings: { providerMs, totalMs: Date.now() - totalStarted },
  });

  // A pure-legacy deployment (no native calendar providers registered)
  // with an unconfigured booking provider preserves the original
  // behavior exactly: a controlled rejection before even the lookup.
  const hasNativeProviders = Object.keys(calendarProviders).length > 0;
  if (!hasNativeProviders && (!bookingProvider || !bookingProvider.configured)) {
    return finish({ outcome: 'rejected', reason: 'booking_not_configured', bookingContextId: null });
  }

  const contextTokenHash = require('node:crypto')
    .createHash('sha256').update(request.bookingContext, 'utf8').digest('hex');
  const context = await bookingContexts.findByTokenHash({ contextTokenHash, organizationKey });
  // Unknown and cross-tenant are deliberately the same answer.
  if (!context) {
    return finish({ outcome: 'rejected', reason: 'booking_context_unknown', bookingContextId: null });
  }
  if (context.status === BookingContextStatus.EXPIRED) {
    return finish({ outcome: 'expired', reason: 'booking_context_expired', bookingContextId: context.bookingContextId });
  }
  if (context.status !== BookingContextStatus.OFFERED) {
    return finish({ outcome: 'rejected', reason: 'booking_context_used', bookingContextId: context.bookingContextId });
  }

  // The context row decides its own path: a native providerKey books
  // through the ADR-0024 calendar-provider contract; a legacy row books
  // through the deployed booking provider. Either way an unconfigured
  // provider is a controlled rejection BEFORE the claim — the context
  // stays claimable for after the configuration is fixed.
  const isNative = Boolean(context.providerKey);
  const nativeProvider = isNative ? calendarProviders[context.providerKey] : null;
  if (isNative ? !nativeProvider : (!bookingProvider || !bookingProvider.configured)) {
    return finish({
      outcome: 'rejected', reason: 'booking_not_configured', bookingContextId: context.bookingContextId,
    });
  }

  // The requested timestamp must be EXACTLY one of the offered
  // timestamps (compared as instants; echoed back in canonical form).
  const requestedMs = Date.parse(request.startsAt);
  const canonicalStartsAt = context.offeredSlots.find((s) => Date.parse(s) === requestedMs);
  if (!canonicalStartsAt) {
    // NOT consumed: the caller may still take a legitimately offered slot.
    return finish({ outcome: 'rejected', reason: 'timestamp_not_offered', bookingContextId: context.bookingContextId });
  }

  // Atomic single-use claim; a concurrent winner, a just-passed expiry,
  // or (native) the slot guard shows up as a failed claim, classified by
  // re-reading: a row STILL OFFERED after a refused claim means the
  // calendar+instant was taken by another live context — a definitive
  // rejection that does NOT consume this context (the caller may still
  // take its other offered slot).
  const claimed = await bookingContexts.claim({
    bookingContextId: context.bookingContextId, startsAt: canonicalStartsAt,
  });
  if (!claimed) {
    const after = await bookingContexts.get(context.bookingContextId);
    if (after && after.status === BookingContextStatus.OFFERED) {
      return finish({
        outcome: 'rejected', reason: 'slot_no_longer_available', bookingContextId: context.bookingContextId,
      });
    }
    const outcome = after && after.status === BookingContextStatus.EXPIRED ? 'expired' : 'rejected';
    return finish({
      outcome,
      reason: outcome === 'expired' ? 'booking_context_expired' : 'booking_context_used',
      bookingContextId: context.bookingContextId,
    });
  }

  if (isNative) {
    return bookNativeAppointment({
      bookingContexts, provider: nativeProvider, configService, organizationKey,
      request, context, claimed, canonicalStartsAt, finish,
    });
  }

  const organization = configService.organizations.get(organizationKey);
  const common = {
    bookingContextId: context.bookingContextId,
    routeKind: context.routeKind,
    sessionId: request.sessionId ?? context.sessionId ?? null,
  };
  const providerStarted = Date.now();
  let confirmed;
  try {
    confirmed = await bookingProvider.createBooking({
      eventTypeId: context.eventTypeId,
      startsAt: canonicalStartsAt,
      attendee: {
        name: request.attendee.name,
        email: request.attendee.email,
        timeZone: organization.timezone,
        ...(request.attendee.phoneNumber ? { phoneNumber: request.attendee.phoneNumber } : {}),
        language: 'en',
      },
      // Operator correlation, no PII: ties the Cal.com booking back to
      // this context for verification_required investigations.
      metadata: { guideherdBookingContextId: context.bookingContextId },
    });
  } catch (err) {
    const providerMs = Date.now() - providerStarted;
    if (err instanceof BookingRejectedByProviderError) {
      await bookingContexts.complete({
        bookingContextId: context.bookingContextId,
        status: BookingContextStatus.REJECTED,
        rejectionReason: `provider_rejected_${err.httpStatus}`,
      });
      return finish({ ...common, outcome: 'rejected', reason: 'provider_rejected', httpStatus: err.httpStatus }, providerMs);
    }
    if (err instanceof BookingUnverifiedError || err instanceof BookingNotConfiguredError) {
      const detail = err instanceof BookingUnverifiedError ? err.detail : 'booking_not_configured';
      await bookingContexts.complete({
        bookingContextId: context.bookingContextId,
        status: BookingContextStatus.VERIFICATION_REQUIRED,
        rejectionReason: detail,
      });
      return finish({ ...common, outcome: 'verification_required', reason: detail }, providerMs);
    }
    // Unknown errors propagate (fail closed; the stale-in-progress
    // reconciliation catches the stranded row).
    throw err;
  }
  const providerMs = Date.now() - providerStarted;

  // Cal.com confirmed. "Booked" is claimable only once the outcome is
  // durably persisted — a persistence failure demotes to
  // verification_required rather than trusting process memory.
  let persisted = null;
  try {
    persisted = await bookingContexts.complete({
      bookingContextId: context.bookingContextId,
      status: BookingContextStatus.BOOKED,
      calcomBookingUid: confirmed.uid,
      bookingResult: confirmed.sanitized,
    });
  } catch {
    persisted = null;
  }
  if (!persisted) {
    try {
      await bookingContexts.complete({
        bookingContextId: context.bookingContextId,
        status: BookingContextStatus.VERIFICATION_REQUIRED,
        calcomBookingUid: confirmed.uid,
        rejectionReason: 'booked_result_persistence_failed',
      });
    } catch {
      // The row stays booking_in_progress; startup reconciliation flips it.
    }
    return finish({ ...common, outcome: 'verification_required', reason: 'booked_result_persistence_failed' }, providerMs);
  }
  return finish({
    ...common,
    outcome: 'booked',
    startsAt: canonicalStartsAt,
    durationMinutes: context.durationMinutes,
    ...(context.routeKind === 'attorney' && context.attorneyId ? { attorneyId: context.attorneyId } : {}),
    calcomBookingUid: confirmed.uid,
  }, providerMs);
}

/**
 * The NATIVE half of the pipeline (GitLab #80): books through the
 * ADR-0024 calendar-provider contract, strictly inside the claimed
 * context. The claim has already bound the exact calendar target for the
 * selected start (pool attribution became THE calendar) — booking never
 * re-chooses a route.
 *
 * Conflict prevention beyond the GuideHerd slot guard: a just-before-
 * create busy re-check catches provider-side conflicts (an event created
 * directly in the attorney's calendar). A failed RE-CHECK is a
 * DEFINITIVE rejection — no provider write was attempted, so nothing is
 * ambiguous; ambiguity classification is reserved for after the create
 * attempt (CalendarWriteUnverifiedError -> verification_required).
 */
async function bookNativeAppointment({
  bookingContexts, provider, configService, organizationKey,
  request, context, claimed, canonicalStartsAt, finish,
}) {
  const common = {
    bookingContextId: context.bookingContextId,
    routeKind: context.routeKind,
    sessionId: request.sessionId ?? context.sessionId ?? null,
  };
  const attributedAttorneyId = claimed.offeredTargets
    ? (claimed.offeredTargets[canonicalStartsAt]?.attorneyId ?? claimed.attorneyId ?? null)
    : (claimed.attorneyId ?? null);
  const startMs = Date.parse(canonicalStartsAt);
  const endMs = startMs + claimed.durationMinutes * 60_000;
  const providerStarted = Date.now();

  // Just-before-create re-verification: the slot must still be free on
  // the target calendar. Overlap OR an unreadable calendar both reject —
  // the context is consumed (claimed), the caller re-checks availability
  // for a fresh offer.
  let recheck;
  try {
    recheck = await provider.fetchBusyIntervals({
      calendarRef: claimed.calendarRef, startUtcMs: startMs, endUtcMs: endMs,
    });
  } catch {
    await bookingContexts.complete({
      bookingContextId: context.bookingContextId,
      status: BookingContextStatus.REJECTED,
      rejectionReason: 'availability_recheck_failed',
    });
    return finish({ ...common, outcome: 'rejected', reason: 'availability_recheck_failed' },
      Date.now() - providerStarted);
  }
  const conflicted = recheck.intervals.some(
    (b) => Date.parse(b.startsAt) < endMs && Date.parse(b.endsAt) > startMs,
  );
  if (conflicted) {
    await bookingContexts.complete({
      bookingContextId: context.bookingContextId,
      status: BookingContextStatus.REJECTED,
      rejectionReason: 'slot_no_longer_available',
    });
    return finish({ ...common, outcome: 'rejected', reason: 'slot_no_longer_available' },
      Date.now() - providerStarted);
  }

  const organization = configService.organizations.get(organizationKey);
  // Whether the PROVIDER also invites the attendee (its own email
  // channel) is tenant policy — DEFAULT OFF (#88): GuideHerd-owned
  // notifications are the customer channel; with the toggle off the
  // attendee is not attached to the provider event at all.
  const { readDomain } = require('../configuration/framework');
  const providerInvitations = readDomain(configService, 'graph-invitations', organizationKey).value.enabled === true;
  let confirmed;
  try {
    confirmed = await provider.createEvent({
      calendarRef: claimed.calendarRef,
      startsAt: canonicalStartsAt,
      durationMinutes: claimed.durationMinutes,
      summary: `${organization.displayName || organization.name} — Consultation with ${request.attendee.name}`,
      ...(providerInvitations ? {
        attendee: {
          name: request.attendee.name,
          email: request.attendee.email,
          ...(request.attendee.phoneNumber ? { phoneNumber: request.attendee.phoneNumber } : {}),
        },
      } : {}),
      // Operator correlation, no PII: the booking-context internal id —
      // reconciliation finds the event by this, never by attendee identity.
      correlationId: context.bookingContextId,
    });
  } catch (err) {
    const providerMs = Date.now() - providerStarted;
    if (err instanceof CalendarWriteRejectedError) {
      await bookingContexts.complete({
        bookingContextId: context.bookingContextId,
        status: BookingContextStatus.REJECTED,
        rejectionReason: `provider_rejected_${err.detail}`,
      });
      return finish({ ...common, outcome: 'rejected', reason: 'provider_rejected' }, providerMs);
    }
    if (err instanceof CalendarWriteUnverifiedError) {
      await bookingContexts.complete({
        bookingContextId: context.bookingContextId,
        status: BookingContextStatus.VERIFICATION_REQUIRED,
        rejectionReason: err.detail,
      });
      return finish({ ...common, outcome: 'verification_required', reason: err.detail }, providerMs);
    }
    // Unknown errors propagate (fail closed; stale-in-progress
    // reconciliation catches the stranded row).
    throw err;
  }
  const providerMs = Date.now() - providerStarted;

  // Confirmed. "booked" is claimable only once the outcome is durably
  // persisted — a persistence failure demotes to verification_required.
  let persisted = null;
  try {
    persisted = await bookingContexts.complete({
      bookingContextId: context.bookingContextId,
      status: BookingContextStatus.BOOKED,
      providerEventId: confirmed.providerEventId,
      bookingResult: confirmed.sanitized,
    });
  } catch {
    persisted = null;
  }
  if (!persisted) {
    try {
      await bookingContexts.complete({
        bookingContextId: context.bookingContextId,
        status: BookingContextStatus.VERIFICATION_REQUIRED,
        providerEventId: confirmed.providerEventId,
        rejectionReason: 'booked_result_persistence_failed',
      });
    } catch {
      // The row stays booking_in_progress; startup reconciliation flips it.
    }
    return finish({ ...common, outcome: 'verification_required', reason: 'booked_result_persistence_failed' }, providerMs);
  }
  return finish({
    ...common,
    outcome: 'booked',
    startsAt: canonicalStartsAt,
    durationMinutes: claimed.durationMinutes,
    ...(attributedAttorneyId ? { attorneyId: attributedAttorneyId } : {}),
    providerEventId: confirmed.providerEventId,
  }, providerMs);
}

/**
 * Startup reconciliation: flip booking_in_progress rows stranded by a
 * crash or redeploy to verification_required — loudly. Called at boot
 * next to the outbox drain; safe to call any time.
 */
async function reconcileStaleBookingContexts({ bookingContexts, telemetry, staleMs } = {}) {
  const flipped = await bookingContexts.reconcileStale(staleMs ? { staleMs } : {});
  if (telemetry) {
    for (const context of flipped) {
      telemetry.event('scheduling.booking_verification_required', {
        severity: 'warn', component: 'scheduling', operation: 'booking-reconciliation',
        organizationKey: context.organizationKey, sessionId: context.sessionId,
        bookingContextId: context.bookingContextId, code: 'stale_booking_in_progress',
      });
    }
  }
  return flipped;
}

module.exports = {
  createCalcomBookingProvider,
  validateBookingRequest,
  bookAppointment,
  reconcileStaleBookingContexts,
  clampBookingTimeoutMs,
  BookingError,
  BookingNotConfiguredError,
  BookingRejectedByProviderError,
  BookingUnverifiedError,
  DEFAULT_BOOKING_TIMEOUT_MS,
  MAX_BOOKING_TIMEOUT_MS,
  BOOKING_CAL_API_VERSION,
};
