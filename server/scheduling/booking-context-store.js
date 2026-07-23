'use strict';

/**
 * In-memory booking-context repository — the reference implementation of
 * the async booking-context repository contract. The PostgreSQL
 * implementation in server/operational/booking-context-repository.js
 * implements the same contract; the shared suite in
 * server/operational/booking-context-contract-suite.js runs against both.
 *
 * A booking context is the durable record of ONE governed availability
 * offer: the resolved routing decision (route kind, event type, duration),
 * the exact offered timestamps, and the booking outcome. It is the single
 * source both availability and booking share — the conversation layer only
 * ever transports the opaque random value whose SHA-256 hash keys the row.
 *
 * State machine:
 *
 *   offered ──claim()──► booking_in_progress ──complete()──► booked
 *      │                        │                            rejected
 *      │                        └────────────────────────► verification_required
 *      └──(lazy expiry on read/claim)──► expired
 *
 * `claim` is the single-use gate: it succeeds at most once per context
 * (atomic conditional transition), so two concurrent booking requests can
 * never both consume the same offer. Timestamp membership is validated by
 * the booking service BEFORE claiming — an invalid request never consumes
 * an offered context.
 *
 * PRODUCTION NOTE: booking correctness must never rest on process-local
 * state. This implementation exists for the contract suite, development,
 * and the in-memory operational profile; production deployments of the
 * booking capability require GUIDEHERD_OPERATIONAL_PROVIDER=postgres.
 */

const BookingContextStatus = Object.freeze({
  OFFERED: 'offered',
  BOOKING_IN_PROGRESS: 'booking_in_progress',
  BOOKED: 'booked',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  VERIFICATION_REQUIRED: 'verification_required',
});

const ROUTE_KINDS = Object.freeze(['attorney', 'routing-group', 'default']);

/** A stranded booking_in_progress older than this is presumed crashed. */
const STALE_BOOKING_MS = 2 * 60 * 1000;

/**
 * Validate the per-kind column consistency the PostgreSQL schema enforces
 * with CHECK constraints — the reference implementation must reject the
 * same shapes so the two stores can never drift.
 * @throws {TypeError}
 */
function assertRouteConsistency(context) {
  const { routeKind, attorneyId, routingGroupKey, practiceAreaId } = context;
  if (!ROUTE_KINDS.includes(routeKind)) {
    throw new TypeError(`Unknown routeKind: ${routeKind}`);
  }
  if (routeKind === 'attorney' && (!attorneyId || routingGroupKey)) {
    throw new TypeError('attorney route requires attorneyId and forbids routingGroupKey');
  }
  if (routeKind === 'routing-group' && (!routingGroupKey || attorneyId || !practiceAreaId)) {
    throw new TypeError('routing-group route requires routingGroupKey and practiceAreaId and forbids attorneyId');
  }
  if (routeKind === 'default' && (attorneyId || routingGroupKey)) {
    throw new TypeError('default route forbids attorneyId and routingGroupKey');
  }
  if (!Number.isInteger(context.eventTypeId) || context.eventTypeId <= 0) {
    throw new TypeError('eventTypeId must be a positive integer');
  }
  if (!Number.isInteger(context.durationMinutes) || context.durationMinutes <= 0) {
    throw new TypeError('durationMinutes must be a positive integer');
  }
  if (!Array.isArray(context.offeredSlots) || context.offeredSlots.length === 0
    || context.offeredSlots.some((s) => typeof s !== 'string' || Number.isNaN(Date.parse(s)))) {
    throw new TypeError('offeredSlots must be a non-empty array of ISO timestamps');
  }
}

/** Public shape: everything except the token hash (nothing needs it back). */
function present(row) {
  const { contextTokenHash, ...pub } = row;
  return { ...pub, offeredSlots: [...pub.offeredSlots] };
}

/**
 * @param {{ clock: { now(): number } }} deps
 */
function createInMemoryBookingContextStore({ clock }) {
  /** @type {Map<string, object>} bookingContextId -> row */
  const byId = new Map();
  /** @type {Map<string, string>} contextTokenHash -> bookingContextId */
  const byHash = new Map();

  /** Lazy expiry: an offered row past expires_at flips on observation. */
  function expireIfDue(row, nowMs) {
    if (row.status === BookingContextStatus.OFFERED && row.expiresAtMs <= nowMs) {
      row.status = BookingContextStatus.EXPIRED;
      row.updatedAtMs = nowMs;
    }
  }

  return {
    /**
     * Insert a new 'offered' context. The raw opaque value never reaches
     * this module — callers supply its SHA-256 hash.
     */
    async create(context) {
      assertRouteConsistency(context);
      if (byId.has(context.bookingContextId) || byHash.has(context.contextTokenHash)) {
        throw new TypeError('booking context already exists');
      }
      const row = {
        bookingContextId: context.bookingContextId,
        contextTokenHash: context.contextTokenHash,
        organizationKey: context.organizationKey,
        sessionId: context.sessionId ?? null,
        routeKind: context.routeKind,
        attorneyId: context.attorneyId ?? null,
        routingGroupKey: context.routingGroupKey ?? null,
        practiceAreaId: context.practiceAreaId ?? null,
        consultationTypeId: context.consultationTypeId ?? null,
        eventTypeId: context.eventTypeId,
        durationMinutes: context.durationMinutes,
        offeredSlots: [...context.offeredSlots],
        status: BookingContextStatus.OFFERED,
        selectedStartsAt: null,
        calcomBookingUid: null,
        bookingResult: null,
        rejectionReason: null,
        createdAtMs: context.createdAtMs ?? clock.now(),
        updatedAtMs: context.createdAtMs ?? clock.now(),
        expiresAtMs: context.expiresAtMs,
      };
      byId.set(row.bookingContextId, row);
      byHash.set(row.contextTokenHash, row.bookingContextId);
      return present(row);
    },

    /**
     * Look up by token hash WITHIN one organization. A hash that exists
     * under another organization is indistinguishable from an unknown
     * hash — existence never leaks across tenants.
     */
    async findByTokenHash({ contextTokenHash, organizationKey }) {
      const id = byHash.get(contextTokenHash);
      if (!id) return null;
      const row = byId.get(id);
      if (row.organizationKey !== organizationKey) return null;
      expireIfDue(row, clock.now());
      return present(row);
    },

    /** Fetch by id (operations/tests; no tenant filter). */
    async get(bookingContextId) {
      const row = byId.get(bookingContextId);
      if (!row) return null;
      expireIfDue(row, clock.now());
      return present(row);
    },

    /**
     * Atomic single-use claim: offered → booking_in_progress. Returns the
     * claimed context, or null when the context is not claimable (already
     * claimed, terminal, or expired) — callers re-read to classify.
     */
    async claim({ bookingContextId, startsAt }) {
      const row = byId.get(bookingContextId);
      if (!row) return null;
      const nowMs = clock.now();
      expireIfDue(row, nowMs);
      if (row.status !== BookingContextStatus.OFFERED) return null;
      row.status = BookingContextStatus.BOOKING_IN_PROGRESS;
      // Normalized ISO form, matching the PostgreSQL timestamptz round trip.
      row.selectedStartsAt = new Date(startsAt).toISOString();
      row.updatedAtMs = nowMs;
      return present(row);
    },

    /**
     * Record the booking outcome: booking_in_progress → booked | rejected
     * | verification_required. Conditional — returns null if the row is
     * not in booking_in_progress (nothing is ever overwritten).
     */
    async complete({ bookingContextId, status, calcomBookingUid, bookingResult, rejectionReason }) {
      if (![BookingContextStatus.BOOKED, BookingContextStatus.REJECTED,
        BookingContextStatus.VERIFICATION_REQUIRED].includes(status)) {
        throw new TypeError(`complete() cannot target status: ${status}`);
      }
      const row = byId.get(bookingContextId);
      if (!row || row.status !== BookingContextStatus.BOOKING_IN_PROGRESS) return null;
      row.status = status;
      row.calcomBookingUid = calcomBookingUid ?? null;
      row.bookingResult = bookingResult ?? null;
      row.rejectionReason = rejectionReason ?? null;
      row.updatedAtMs = clock.now();
      return present(row);
    },

    /**
     * Startup/periodic reconciliation: booking_in_progress rows stranded
     * longer than `staleMs` (crash mid-booking — the provider call may or
     * may not have succeeded) flip to verification_required so an operator
     * investigates. Returns the flipped contexts.
     */
    async reconcileStale({ staleMs = STALE_BOOKING_MS } = {}) {
      const nowMs = clock.now();
      const flipped = [];
      for (const row of byId.values()) {
        if (row.status === BookingContextStatus.BOOKING_IN_PROGRESS
          && row.updatedAtMs <= nowMs - staleMs) {
          row.status = BookingContextStatus.VERIFICATION_REQUIRED;
          row.rejectionReason = 'stale_booking_in_progress';
          row.updatedAtMs = nowMs;
          flipped.push(present(row));
        }
      }
      return flipped;
    },
  };
}

module.exports = {
  createInMemoryBookingContextStore,
  BookingContextStatus,
  ROUTE_KINDS,
  STALE_BOOKING_MS,
  assertRouteConsistency,
};
