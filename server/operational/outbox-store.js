'use strict';

/**
 * PostgreSQL outbox store (ADR-0017) — the durable implementation of the
 * outbox store contract in server/outbox/outbox.js.
 *
 * append() accepts an optional transaction RUNNER: the publishing
 * repository passes its own transaction client, so the event INSERT
 * commits or rolls back with the business change — the exact
 * transactional guarantee. Claims are atomic conditional INSERT/UPDATEs
 * (the platform's standard claim pattern), multi-instance safe: at most
 * one processor holds a delivery, stale `processing` claims re-claim
 * after the stale window, and 'completed'/'abandoned' are terminal.
 * Timestamps come from the injected clock as bind parameters (ADR-0006
 * determinism discipline).
 */

const { validateEvent, OUTBOX_STALE_PROCESSING_MS } = require('../outbox/outbox');

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresOutboxStore({ pool, clock }) {
  const nowDate = () => new Date(clock.now());

  function toEvent(row) {
    return {
      id: Number(row.id),
      at: new Date(row.created_at).getTime(),
      type: row.event_type,
      organizationKey: row.organization_key,
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      payload: row.payload_json ? JSON.parse(row.payload_json) : {},
    };
  }

  return {
    /**
     * Append one event. Pass the business transaction's client as
     * `runner` to join that transaction; defaults to the pool.
     */
    async append(event, runner = pool) {
      const validated = validateEvent(event);
      const { rows } = await runner.query(
        `INSERT INTO outbox_events (event_type, organization_key, session_id, correlation_id, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [validated.type, validated.organizationKey, validated.sessionId, validated.correlationId,
          JSON.stringify(validated.payload), nowDate()],
      );
      return { id: Number(rows[0].id), at: new Date(rows[0].created_at).getTime(), ...validated };
    },

    /** Events with no terminal delivery for the consumer, oldest first. */
    async claimable(consumer, { limit = 50 } = {}) {
      const now = nowDate();
      const staleBefore = new Date(clock.now() - OUTBOX_STALE_PROCESSING_MS);
      const { rows } = await pool.query(
        `SELECT e.* FROM outbox_events e
           LEFT JOIN outbox_deliveries d ON d.event_id = e.id AND d.consumer = $1
          WHERE d.event_id IS NULL
             OR (d.status = 'failed' AND d.next_attempt_at <= $2)
             OR (d.status = 'processing' AND d.updated_at <= $3)
          ORDER BY e.id ASC
          LIMIT $4`,
        [consumer, now, staleBefore, Math.max(1, limit)],
      );
      return rows.map(toEvent);
    },

    /** Atomic claim: one conditional INSERT/UPDATE, one winner. */
    async claim(eventId, consumer) {
      const now = nowDate();
      const staleBefore = new Date(clock.now() - OUTBOX_STALE_PROCESSING_MS);
      const { rows } = await pool.query(
        `INSERT INTO outbox_deliveries (event_id, consumer, status, attempts, updated_at)
         VALUES ($1, $2, 'processing', 1, $3)
         ON CONFLICT (event_id, consumer) DO UPDATE
           SET status = 'processing', attempts = outbox_deliveries.attempts + 1,
               next_attempt_at = NULL, updated_at = $3
           WHERE (outbox_deliveries.status = 'failed' AND outbox_deliveries.next_attempt_at <= $3)
              OR (outbox_deliveries.status = 'processing' AND outbox_deliveries.updated_at <= $4)
         RETURNING attempts`,
        [eventId, consumer, now, staleBefore],
      );
      if (rows.length === 0) return null;
      return { eventId, consumer, status: 'processing', attempts: rows[0].attempts };
    },

    async complete(eventId, consumer) {
      await pool.query(
        `UPDATE outbox_deliveries SET status = 'completed', next_attempt_at = NULL, updated_at = $3
          WHERE event_id = $1 AND consumer = $2`,
        [eventId, consumer, nowDate()],
      );
    },

    async fail(eventId, consumer, { abandoned, nextAttemptAtMs }) {
      await pool.query(
        `UPDATE outbox_deliveries SET status = $3, next_attempt_at = $4, updated_at = $5
          WHERE event_id = $1 AND consumer = $2`,
        [eventId, consumer, abandoned ? 'abandoned' : 'failed',
          abandoned || !nextAttemptAtMs ? null : new Date(nextAttemptAtMs), nowDate()],
      );
    },

    /** Recent events, newest first (Operations Center history). */
    async listRecent({ organizationKey, limit = 100 } = {}) {
      const params = [];
      let where = '';
      if (organizationKey) {
        params.push(organizationKey);
        where = `WHERE organization_key = $${params.length}`;
      }
      params.push(Math.max(1, limit));
      const { rows } = await pool.query(
        `SELECT * FROM outbox_events ${where} ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toEvent);
    },

    async deliveryOf(eventId, consumer) {
      const { rows } = await pool.query(
        'SELECT status, attempts, next_attempt_at, updated_at FROM outbox_deliveries WHERE event_id = $1 AND consumer = $2',
        [eventId, consumer],
      );
      if (rows.length === 0) return null;
      return {
        eventId, consumer,
        status: rows[0].status,
        attempts: rows[0].attempts,
        nextAttemptAtMs: rows[0].next_attempt_at ? new Date(rows[0].next_attempt_at).getTime() : null,
        updatedAtMs: new Date(rows[0].updated_at).getTime(),
      };
    },

    async size() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox_events');
      return rows[0].n;
    },
  };
}

module.exports = { createPostgresOutboxStore };
