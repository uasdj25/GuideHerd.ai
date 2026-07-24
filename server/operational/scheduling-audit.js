'use strict';

/**
 * PostgreSQL scheduling-audit sink (GitLab #80) — the durable
 * implementation of the append-only scheduling audit contract (reference
 * implementation: createInMemoryAuditLog in
 * server/scheduling/booking-context-store.js).
 *
 * Contract rules:
 *   - record() NEVER throws into a state transition: a failed audit
 *     write is loud telemetry (internal.unexpected_error), not a booking
 *     failure — the transition already committed;
 *   - entries carry internal identifiers, action codes, and small
 *     sanitized details ONLY (no raw context tokens, no attendee PII,
 *     no raw provider payloads — enforced at the call sites and by the
 *     narrow column set).
 */

function createPostgresSchedulingAudit({ pool, telemetry = null }) {
  return {
    async record({ bookingContextId, organizationKey, occurredAtMs, actor, action, detail = null }) {
      try {
        await pool.query(
          `INSERT INTO scheduling_audit
             (booking_context_id, organization_key, occurred_at, actor, action, detail)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            bookingContextId, organizationKey, new Date(occurredAtMs), actor, action,
            detail === null || detail === undefined ? null : JSON.stringify(detail),
          ],
        );
      } catch (err) {
        if (telemetry) {
          telemetry.event('internal.unexpected_error', {
            severity: 'error', component: 'scheduling', operation: 'audit-write',
            code: 'audit_write_failed', errorName: err && err.name,
          });
        }
      }
    },

    async listByContext(bookingContextId) {
      const { rows } = await pool.query(
        `SELECT booking_context_id, organization_key, occurred_at, actor, action, detail
           FROM scheduling_audit
          WHERE booking_context_id = $1
          ORDER BY occurred_at, audit_id`,
        [bookingContextId],
      );
      return rows.map((r) => ({
        bookingContextId: r.booking_context_id,
        organizationKey: r.organization_key,
        occurredAtMs: new Date(r.occurred_at).getTime(),
        actor: r.actor,
        action: r.action,
        detail: r.detail,
      }));
    },
  };
}

module.exports = { createPostgresSchedulingAudit };
