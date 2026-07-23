'use strict';

/**
 * PostgreSQL booking-context repository — the durable implementation of
 * the async booking-context repository contract. Behavior mirrors the
 * reference implementation in server/scheduling/booking-context-store.js
 * transition for transition; the shared contract suite runs against both.
 *
 * Atomicity: the single-use claim and the outcome record are each ONE
 * conditional `UPDATE … WHERE status = … RETURNING` — the database
 * serializes writers on the row, so of two concurrent booking requests
 * exactly one claim predicate matches, across any number of API
 * instances. PostgreSQL is authoritative for expiry, cross-tenant
 * opacity, single-use enforcement, and the durable booking outcome;
 * process restarts lose nothing (stranded in-progress rows are flipped
 * to verification_required by reconcileStale at boot).
 *
 * Determinism: every timestamp comes from the injected clock and is
 * passed as a bind parameter — SQL now() is never used in transition
 * logic. Expiration stays lazy, exactly as in memory.
 *
 * Nothing sensitive lives here: the raw bookingContext value never
 * reaches this module (SHA-256 hash only), attendee data is never
 * persisted, and errors are rethrown without bind values.
 */

const {
  BookingContextStatus,
  STALE_BOOKING_MS,
  assertRouteConsistency,
} = require('../scheduling/booking-context-store');

/** timestamptz -> epoch ms (or null). */
function ms(value) {
  return value === null || value === undefined ? null : new Date(value).getTime();
}

/** Map a booking_contexts row to the public contract shape (no hash). */
function toContext(row) {
  return {
    bookingContextId: row.booking_context_id,
    organizationKey: row.organization_key,
    sessionId: row.session_id,
    routeKind: row.route_kind,
    attorneyId: row.attorney_id,
    routingGroupKey: row.routing_group_key,
    practiceAreaId: row.practice_area_id,
    consultationTypeId: row.consultation_type_id,
    eventTypeId: Number(row.event_type_id),
    durationMinutes: row.duration_minutes,
    offeredSlots: row.offered_slots,
    status: row.status,
    selectedStartsAt: row.selected_starts_at === null ? null : new Date(row.selected_starts_at).toISOString(),
    calcomBookingUid: row.calcom_booking_uid,
    bookingResult: row.booking_result,
    rejectionReason: row.rejection_reason,
    createdAtMs: ms(row.created_at),
    updatedAtMs: ms(row.updated_at),
    expiresAtMs: ms(row.expires_at),
  };
}

/**
 * @param {{ pool: import('pg').Pool, clock: { now(): number } }} deps
 */
function createPostgresBookingContextStore({ pool, clock }) {
  const nowDate = () => new Date(clock.now());

  /** Lazy expiry: flip an offered row past expires_at on observation. */
  async function expireIfDue(bookingContextId, now) {
    await pool.query(
      `UPDATE booking_contexts SET status = 'expired', updated_at = $2
        WHERE booking_context_id = $1 AND status = 'offered' AND expires_at <= $2`,
      [bookingContextId, now],
    );
  }

  return {
    async create(context) {
      assertRouteConsistency(context);
      const createdAt = new Date(context.createdAtMs ?? clock.now());
      const { rows } = await pool.query(
        `INSERT INTO booking_contexts (
           booking_context_id, context_token_hash, organization_key, session_id,
           route_kind, attorney_id, routing_group_key, practice_area_id,
           consultation_type_id, event_type_id, duration_minutes, offered_slots,
           status, created_at, updated_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'offered',$13,$13,$14)
         RETURNING *`,
        [
          context.bookingContextId, context.contextTokenHash, context.organizationKey,
          context.sessionId ?? null, context.routeKind, context.attorneyId ?? null,
          context.routingGroupKey ?? null, context.practiceAreaId ?? null,
          context.consultationTypeId ?? null, context.eventTypeId, context.durationMinutes,
          JSON.stringify(context.offeredSlots), createdAt, new Date(context.expiresAtMs),
        ],
      );
      return toContext(rows[0]);
    },

    async findByTokenHash({ contextTokenHash, organizationKey }) {
      const now = nowDate();
      const { rows } = await pool.query(
        'SELECT booking_context_id FROM booking_contexts WHERE context_token_hash = $1 AND organization_key = $2',
        [contextTokenHash, organizationKey],
      );
      if (rows.length === 0) return null;
      await expireIfDue(rows[0].booking_context_id, now);
      const { rows: fresh } = await pool.query(
        'SELECT * FROM booking_contexts WHERE booking_context_id = $1',
        [rows[0].booking_context_id],
      );
      return toContext(fresh[0]);
    },

    async get(bookingContextId) {
      await expireIfDue(bookingContextId, nowDate());
      const { rows } = await pool.query(
        'SELECT * FROM booking_contexts WHERE booking_context_id = $1',
        [bookingContextId],
      );
      return rows.length === 0 ? null : toContext(rows[0]);
    },

    async claim({ bookingContextId, startsAt }) {
      const now = nowDate();
      const { rows } = await pool.query(
        `UPDATE booking_contexts
            SET status = 'booking_in_progress', selected_starts_at = $2, updated_at = $3
          WHERE booking_context_id = $1 AND status = 'offered' AND expires_at > $3
          RETURNING *`,
        [bookingContextId, new Date(startsAt), now],
      );
      if (rows.length === 0) {
        await expireIfDue(bookingContextId, now);
        return null;
      }
      return toContext(rows[0]);
    },

    async complete({ bookingContextId, status, calcomBookingUid, bookingResult, rejectionReason }) {
      if (![BookingContextStatus.BOOKED, BookingContextStatus.REJECTED,
        BookingContextStatus.VERIFICATION_REQUIRED].includes(status)) {
        throw new TypeError(`complete() cannot target status: ${status}`);
      }
      const { rows } = await pool.query(
        `UPDATE booking_contexts
            SET status = $2, calcom_booking_uid = $3, booking_result = $4,
                rejection_reason = $5, updated_at = $6
          WHERE booking_context_id = $1 AND status = 'booking_in_progress'
          RETURNING *`,
        [
          bookingContextId, status, calcomBookingUid ?? null,
          bookingResult === undefined || bookingResult === null ? null : JSON.stringify(bookingResult),
          rejectionReason ?? null, nowDate(),
        ],
      );
      return rows.length === 0 ? null : toContext(rows[0]);
    },

    async reconcileStale({ staleMs = STALE_BOOKING_MS } = {}) {
      const now = nowDate();
      const { rows } = await pool.query(
        `UPDATE booking_contexts
            SET status = 'verification_required',
                rejection_reason = 'stale_booking_in_progress', updated_at = $1
          WHERE status = 'booking_in_progress' AND updated_at <= $2
          RETURNING *`,
        [now, new Date(clock.now() - staleMs)],
      );
      return rows.map(toContext);
    },
  };
}

module.exports = { createPostgresBookingContextStore };
