'use strict';

/**
 * PostgreSQL scheduled-action store (ADR-0018) — the durable
 * implementation of the scheduler store contract in
 * server/scheduler/scheduler.js. Same semantics, made multi-instance
 * safe with atomic conditional writes: across any number of API
 * instances, at most one concurrent executor claims an action, dedupe
 * is the primary key, and terminal states are final.
 *
 * Timestamps come from the injected clock as bind parameters (ADR-0006
 * determinism discipline).
 */

const {
  validateScheduledAction,
  presentState,
  SCHEDULER_STALE_PROCESSING_MS,
  TERMINAL_STATES,
} = require('../scheduler/scheduler');

function rowToRecord(row) {
  return {
    actionKey: row.action_key,
    actionType: row.action_type,
    organizationKey: row.organization_key,
    sessionId: row.session_id,
    correlationId: row.correlation_id,
    runAtMs: new Date(row.run_at).getTime(),
    expiresAtMs: row.expires_at === null ? null : new Date(row.expires_at).getTime(),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at === null ? null : new Date(row.next_attempt_at).getTime(),
    payload: row.payload_json || {},
    createdAtMs: new Date(row.created_at).getTime(),
    updatedAtMs: new Date(row.updated_at).getTime(),
  };
}

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresScheduledActionStore({ pool, clock }) {
  return {
    async schedule(action) {
      const validated = validateScheduledAction(action);
      const now = new Date(clock.now());
      const { rows } = await pool.query(
        `INSERT INTO scheduled_actions
           (action_key, action_type, organization_key, session_id, correlation_id,
            run_at, expires_at, state, attempts, payload_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $9, $9)
         ON CONFLICT (action_key) DO NOTHING
         RETURNING *`,
        [
          validated.actionKey, validated.actionType, validated.organizationKey,
          validated.sessionId, validated.correlationId,
          new Date(validated.runAtMs),
          validated.expiresAtMs === null ? null : new Date(validated.expiresAtMs),
          JSON.stringify(validated.payload), now,
        ],
      );
      if (rows.length === 1) return { scheduled: true, action: rowToRecord(rows[0]) };
      const { rows: existing } = await pool.query(
        'SELECT * FROM scheduled_actions WHERE action_key = $1', [validated.actionKey],
      );
      return { scheduled: false, action: existing.length ? rowToRecord(existing[0]) : null };
    },

    async cancel(actionKey) {
      const now = new Date(clock.now());
      const { rows } = await pool.query(
        `UPDATE scheduled_actions SET state = 'cancelled', updated_at = $2
          WHERE action_key = $1 AND state NOT IN ('completed', 'cancelled', 'expired')
          RETURNING state`,
        [actionKey, now],
      );
      if (rows.length === 1) return { cancelled: true, state: 'cancelled' };
      const { rows: existing } = await pool.query(
        'SELECT state FROM scheduled_actions WHERE action_key = $1', [actionKey],
      );
      return { cancelled: false, state: existing.length ? existing[0].state : null };
    },

    async expireDue(nowMs) {
      const now = new Date(nowMs);
      const { rows } = await pool.query(
        `UPDATE scheduled_actions SET state = 'expired', updated_at = $1
          WHERE expires_at IS NOT NULL AND expires_at <= $1
            AND state NOT IN ('completed', 'cancelled', 'expired')
          RETURNING *`,
        [now],
      );
      return rows.map(rowToRecord);
    },

    async claimable({ maxAttempts, limit = 50 } = {}) {
      const now = new Date(clock.now());
      const staleBefore = new Date(clock.now() - SCHEDULER_STALE_PROCESSING_MS);
      const { rows } = await pool.query(
        `SELECT * FROM scheduled_actions
          WHERE (state = 'pending' AND run_at <= $1)
             OR (state = 'failed' AND attempts < $2 AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1)
             OR (state = 'processing' AND updated_at <= $3)
          ORDER BY run_at ASC, action_key ASC
          LIMIT $4`,
        [now, maxAttempts, staleBefore, limit],
      );
      return rows.map(rowToRecord);
    },

    /** Atomic claim: one conditional UPDATE — the multi-instance guard. */
    async claim(actionKey, { maxAttempts } = {}) {
      const now = new Date(clock.now());
      const staleBefore = new Date(clock.now() - SCHEDULER_STALE_PROCESSING_MS);
      const { rows } = await pool.query(
        `UPDATE scheduled_actions
            SET state = 'processing', attempts = attempts + 1,
                next_attempt_at = NULL, updated_at = $2
          WHERE action_key = $1
            AND ((state = 'pending' AND run_at <= $2)
              OR (state = 'failed' AND attempts < $3 AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2)
              OR (state = 'processing' AND updated_at <= $4))
          RETURNING *`,
        [actionKey, now, maxAttempts, staleBefore],
      );
      return rows.length === 1 ? rowToRecord(rows[0]) : null;
    },

    async complete(actionKey) {
      await pool.query(
        `UPDATE scheduled_actions SET state = 'completed', updated_at = $2 WHERE action_key = $1`,
        [actionKey, new Date(clock.now())],
      );
    },

    async fail(actionKey, { nextAttemptAtMs }) {
      await pool.query(
        `UPDATE scheduled_actions SET state = 'failed', next_attempt_at = $2, updated_at = $3
          WHERE action_key = $1`,
        [actionKey, nextAttemptAtMs === null || nextAttemptAtMs === undefined ? null : new Date(nextAttemptAtMs), new Date(clock.now())],
      );
    },

    async listRecent({ organizationKey, limit = 100 } = {}) {
      const params = organizationKey ? [organizationKey, limit] : [limit];
      const { rows } = await pool.query(
        `SELECT * FROM scheduled_actions
          ${organizationKey ? 'WHERE organization_key = $1' : ''}
          ORDER BY created_at DESC, action_key ASC
          LIMIT $${params.length}`,
        params,
      );
      const nowMs = clock.now();
      return rows.map((row) => {
        const record = rowToRecord(row);
        return { ...record, presentedState: presentState(record, nowMs) };
      });
    },

    async get(actionKey) {
      const { rows } = await pool.query(
        'SELECT * FROM scheduled_actions WHERE action_key = $1', [actionKey],
      );
      if (!rows.length) return undefined;
      const record = rowToRecord(rows[0]);
      return { ...record, presentedState: presentState(record, clock.now()) };
    },

    async size() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM scheduled_actions');
      return rows[0].n;
    },

    /** The pool is owned by the handoff repository; nothing to close here. */
    async close() {},
  };
}

module.exports = { createPostgresScheduledActionStore, TERMINAL_STATES };
