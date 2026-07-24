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
  CANCELLATION_PENDING: 'cancellation_pending',
  CANCELLED: 'cancelled',
  RESCHEDULING: 'rescheduling',
  RESCHEDULED: 'rescheduled',
});

/** Statuses that OCCUPY a calendar instant (the slot-guard predicate):
 *  a cancellation still in flight keeps its event until the provider
 *  confirms, so it keeps its slot too. */
const SLOT_OCCUPYING_STATUSES = Object.freeze([
  'booking_in_progress', 'booked', 'cancellation_pending', 'rescheduling',
]);

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
  if (!Array.isArray(context.offeredSlots) || context.offeredSlots.length === 0
    || context.offeredSlots.some((s) => typeof s !== 'string' || Number.isNaN(Date.parse(s)))) {
    throw new TypeError('offeredSlots must be a non-empty array of ISO timestamps');
  }
  // Target presence (mirrors booking_contexts_target_presence): a context
  // books through EITHER a legacy provider event type OR a native
  // calendar target set — never neither.
  const isLegacy = context.eventTypeId !== null && context.eventTypeId !== undefined;
  const isNative = typeof context.providerKey === 'string' && context.providerKey.trim() !== '';
  if (isLegacy && (!Number.isInteger(context.eventTypeId) || context.eventTypeId <= 0)) {
    throw new TypeError('eventTypeId must be a positive integer');
  }
  if (!isLegacy && !isNative) {
    throw new TypeError('a context requires an eventTypeId or a native providerKey + offeredTargets');
  }
  if (isNative && !isLegacy) {
    const targets = context.offeredTargets;
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
      throw new TypeError('native contexts require offeredTargets mapping each offered start to its target');
    }
    for (const startsAt of context.offeredSlots) {
      const target = targets[startsAt];
      if (!target || typeof target.calendarRef !== 'string' || target.calendarRef.trim() === '') {
        throw new TypeError(`offeredTargets is missing a calendar target for ${startsAt}`);
      }
    }
  }
  if (!Number.isInteger(context.durationMinutes) || context.durationMinutes <= 0) {
    throw new TypeError('durationMinutes must be a positive integer');
  }
}

/**
 * In-memory append-only audit log — the reference audit sink (the
 * PostgreSQL sink lives in server/operational/scheduling-audit.js). A
 * sink NEVER throws into a state transition: recording is best-effort by
 * contract; failures are the sink's own telemetry concern.
 */
function createInMemoryAuditLog() {
  const records = [];
  return {
    async record(entry) {
      records.push({ ...entry });
    },
    async listByContext(bookingContextId) {
      return records.filter((r) => r.bookingContextId === bookingContextId).map((r) => ({ ...r }));
    },
    records,
  };
}

/** Public shape: everything except the token hash (nothing needs it back). */
function present(row) {
  const { contextTokenHash, ...pub } = row;
  return { ...pub, offeredSlots: [...pub.offeredSlots] };
}

/**
 * @param {{ clock: { now(): number }, audit?: { record(entry): Promise<void>|void } }} deps
 */
function createInMemoryBookingContextStore({ clock, audit = null }) {
  /** @type {Map<string, object>} bookingContextId -> row */
  const byId = new Map();
  /** @type {Map<string, string>} contextTokenHash -> bookingContextId */
  const byHash = new Map();

  /** Best-effort audit AFTER a committed transition — never a failure path. */
  async function emitAudit(action, row, { actor = 'caller-flow', detail = null } = {}) {
    if (!audit) return;
    try {
      await audit.record({
        bookingContextId: row.bookingContextId,
        organizationKey: row.organizationKey,
        occurredAtMs: clock.now(),
        actor,
        action,
        detail,
      });
    } catch {
      // The sink owns its failure telemetry; a transition never fails on audit.
    }
  }

  /** Lazy expiry: an offered row past expires_at flips on observation. */
  function expireIfDue(row, nowMs) {
    if (row.status === BookingContextStatus.OFFERED && row.expiresAtMs <= nowMs) {
      row.status = BookingContextStatus.EXPIRED;
      row.updatedAtMs = nowMs;
      emitAudit('expired', row, { actor: 'system' });
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
        eventTypeId: context.eventTypeId ?? null,
        durationMinutes: context.durationMinutes,
        offeredSlots: [...context.offeredSlots],
        providerKey: context.providerKey ?? null,
        calendarRef: context.calendarRef ?? null,
        offeredTargets: context.offeredTargets ? { ...context.offeredTargets } : null,
        providerEventId: null,
        rescheduleOf: context.rescheduleOf ?? null,
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
      await emitAudit('created', row, { detail: { routeKind: row.routeKind } });
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
     * claimed, terminal, expired, OR — native rows — when the slot guard
     * finds the same calendar+instant already claimed or booked by
     * another context; callers re-read to classify, and a still-offered
     * row after a null claim IS the guard case: slot_no_longer_available
     * without consumption).
     */
    async claim({ bookingContextId, startsAt }) {
      const row = byId.get(bookingContextId);
      if (!row) return null;
      const nowMs = clock.now();
      expireIfDue(row, nowMs);
      if (row.status !== BookingContextStatus.OFFERED) return null;
      // Normalized ISO form, matching the PostgreSQL timestamptz round trip.
      const selected = new Date(startsAt).toISOString();
      // Native rows: the claim binds the exact offered target for the
      // selected start (pool attribution becomes THE calendar), then the
      // slot guard refuses a second live claim of the same calendar+instant
      // (mirrors booking_contexts_slot_guard_idx).
      let calendarRef = row.calendarRef;
      if (row.offeredTargets) {
        const target = row.offeredTargets[selected]
          ?? row.offeredTargets[Object.keys(row.offeredTargets).find((k) => Date.parse(k) === Date.parse(selected))];
        if (target) calendarRef = target.calendarRef;
      }
      if (calendarRef) {
        for (const other of byId.values()) {
          if (other !== row
            && other.organizationKey === row.organizationKey
            && other.calendarRef === calendarRef
            && other.selectedStartsAt === selected
            && SLOT_OCCUPYING_STATUSES.includes(other.status)) {
            return null; // guard: the row stays OFFERED, unconsumed
          }
        }
      }
      row.status = BookingContextStatus.BOOKING_IN_PROGRESS;
      row.selectedStartsAt = selected;
      row.calendarRef = calendarRef;
      row.updatedAtMs = nowMs;
      await emitAudit('claimed', row, { detail: { selectedStartsAt: selected } });
      return present(row);
    },

    /**
     * Record the booking outcome: booking_in_progress → booked | rejected
     * | verification_required. Conditional — returns null if the row is
     * not in booking_in_progress (nothing is ever overwritten).
     */
    async complete({ bookingContextId, status, calcomBookingUid, providerEventId, bookingResult, rejectionReason, actor = 'caller-flow' }) {
      if (![BookingContextStatus.BOOKED, BookingContextStatus.REJECTED,
        BookingContextStatus.VERIFICATION_REQUIRED].includes(status)) {
        throw new TypeError(`complete() cannot target status: ${status}`);
      }
      const row = byId.get(bookingContextId);
      if (!row || row.status !== BookingContextStatus.BOOKING_IN_PROGRESS) return null;
      row.status = status;
      row.calcomBookingUid = calcomBookingUid ?? null;
      row.providerEventId = providerEventId ?? null;
      row.bookingResult = bookingResult ?? null;
      row.rejectionReason = rejectionReason ?? null;
      row.updatedAtMs = clock.now();
      await emitAudit(status, row, { actor, detail: rejectionReason ? { reason: rejectionReason } : null });
      return present(row);
    },

    /**
     * Atomic single-winner start of a cancellation: booked ->
     * cancellation_pending (mirrors the booking claim — two concurrent
     * cancel requests can never both drive the provider call). Returns
     * the pending context or null when the row is not cancellable from
     * its current state.
     */
    async beginCancellation({ bookingContextId, actor = 'operator' }) {
      const row = byId.get(bookingContextId);
      if (!row || row.status !== BookingContextStatus.BOOKED) return null;
      row.status = BookingContextStatus.CANCELLATION_PENDING;
      row.updatedAtMs = clock.now();
      await emitAudit('cancellation_pending', row, { actor });
      return present(row);
    },

    /**
     * Record the cancellation outcome: cancellation_pending -> cancelled
     * (provider confirmed, or the event definitively no longer exists) |
     * verification_required (ambiguous — the intent stays recorded) |
     * booked (a definitive provider refusal REVERTS: the appointment
     * still stands). Conditional; nothing is ever overwritten.
     */
    async completeCancellation({ bookingContextId, status, rejectionReason, actor = 'operator' }) {
      if (![BookingContextStatus.CANCELLED, BookingContextStatus.VERIFICATION_REQUIRED,
        BookingContextStatus.BOOKED].includes(status)) {
        throw new TypeError(`completeCancellation() cannot target status: ${status}`);
      }
      const row = byId.get(bookingContextId);
      if (!row || row.status !== BookingContextStatus.CANCELLATION_PENDING) return null;
      row.status = status;
      row.rejectionReason = rejectionReason ?? null;
      row.updatedAtMs = clock.now();
      await emitAudit(status === BookingContextStatus.BOOKED ? 'cancellation_reverted' : status, row, {
        actor, detail: rejectionReason ? { reason: rejectionReason } : null,
      });
      return present(row);
    },

    /**
     * Atomic single-winner start of a reschedule: booked -> rescheduling.
     * The original keeps occupying its OLD instant (guard) while the
     * provider update is in flight.
     */
    async beginReschedule({ bookingContextId, actor = 'caller-flow' }) {
      const row = byId.get(bookingContextId);
      if (!row || row.status !== BookingContextStatus.BOOKED) return null;
      row.status = BookingContextStatus.RESCHEDULING;
      row.updatedAtMs = clock.now();
      await emitAudit('rescheduling', row, { actor });
      return present(row);
    },

    /**
     * Record the reschedule outcome on the ORIGINAL context:
     * rescheduling -> rescheduled (terminal; the successor context holds
     * the live appointment) | booked (REVERTED — the update was
     * definitively refused; the original appointment stands) |
     * verification_required (ambiguous — the event may be at either
     * time; reconciliation resolves from the event's actual start).
     */
    async completeReschedule({ bookingContextId, status, rejectionReason, actor = 'caller-flow' }) {
      if (![BookingContextStatus.RESCHEDULED, BookingContextStatus.VERIFICATION_REQUIRED,
        BookingContextStatus.BOOKED].includes(status)) {
        throw new TypeError(`completeReschedule() cannot target status: ${status}`);
      }
      const row = byId.get(bookingContextId);
      if (!row || row.status !== BookingContextStatus.RESCHEDULING) return null;
      row.status = status;
      row.rejectionReason = rejectionReason ?? null;
      row.updatedAtMs = clock.now();
      await emitAudit(status === BookingContextStatus.BOOKED ? 'reschedule_reverted' : status, row, {
        actor, detail: rejectionReason ? { reason: rejectionReason } : null,
      });
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
        const staleKind = {
          [BookingContextStatus.BOOKING_IN_PROGRESS]: 'stale_booking_in_progress',
          [BookingContextStatus.CANCELLATION_PENDING]: 'stale_cancellation_pending',
          [BookingContextStatus.RESCHEDULING]: 'stale_rescheduling',
        }[row.status] ?? null;
        if (staleKind && row.updatedAtMs <= nowMs - staleMs) {
          row.status = BookingContextStatus.VERIFICATION_REQUIRED;
          row.rejectionReason = staleKind;
          row.updatedAtMs = nowMs;
          await emitAudit('verification_required', row, {
            actor: 'reconciler', detail: { reason: staleKind },
          });
          flipped.push(present(row));
        }
      }
      return flipped;
    },
  };
}

module.exports = {
  createInMemoryBookingContextStore,
  createInMemoryAuditLog,
  BookingContextStatus,
  ROUTE_KINDS,
  SLOT_OCCUPYING_STATUSES,
  STALE_BOOKING_MS,
  assertRouteConsistency,
};
