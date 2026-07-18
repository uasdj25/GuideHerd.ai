'use strict';

/**
 * PostgreSQL integration delivery store (ADR-0020) — the durable
 * implementation of the delivery-idempotency contract in
 * server/integrations/delivery-store.js. Same semantics, made
 * multi-instance safe with one atomic conditional INSERT/UPDATE: across
 * any number of API instances, at most one concurrent caller holds the
 * claim for an integrationKey, and 'completed' is final forever.
 *
 * Timestamps come from the injected clock as bind parameters (ADR-0006
 * determinism discipline). Nothing sensitive is stored: keys carry
 * GuideHerd identifiers only.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresIntegrationDeliveryStore({ pool, clock }) {
  return {
    async claim(integrationKey) {
      const now = new Date(clock.now());
      const staleBefore = new Date(clock.now() - STALE_CLAIM_MS);
      const { rows } = await pool.query(
        `INSERT INTO integration_deliveries (integration_key, status, claimed_at, created_at)
         VALUES ($1, 'pending', $2, $2)
         ON CONFLICT (integration_key) DO UPDATE
           SET status = 'pending', claimed_at = $2
           WHERE integration_deliveries.status = 'failed'
              OR (integration_deliveries.status = 'pending' AND integration_deliveries.claimed_at <= $3)
         RETURNING status`,
        [integrationKey, now, staleBefore],
      );
      if (rows.length === 1) return { claimed: true, status: 'pending' };
      const { rows: existing } = await pool.query(
        'SELECT status FROM integration_deliveries WHERE integration_key = $1',
        [integrationKey],
      );
      return { claimed: false, status: existing.length ? existing[0].status : null };
    },

    async record(integrationKey, status) {
      await pool.query(
        'UPDATE integration_deliveries SET status = $2 WHERE integration_key = $1',
        [integrationKey, status],
      );
      return { integrationKey, status };
    },

    /** Operational visibility (ADR-0014): recent delivery records. */
    async listRecent({ limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT integration_key, status, claimed_at FROM integration_deliveries
          ORDER BY claimed_at DESC NULLS LAST, integration_key ASC
          LIMIT $1`,
        [Math.max(1, limit)],
      );
      return rows.map((r) => ({
        integrationKey: r.integration_key,
        status: r.status,
        claimedAtMs: r.claimed_at === null ? null : new Date(r.claimed_at).getTime(),
      }));
    },

    async get(integrationKey) {
      const { rows } = await pool.query(
        'SELECT integration_key, status FROM integration_deliveries WHERE integration_key = $1',
        [integrationKey],
      );
      return rows.length ? { integrationKey: rows[0].integration_key, status: rows[0].status } : undefined;
    },

    /** The pool is owned by the handoff repository; nothing to drain here. */
    async close() {},
  };
}

module.exports = { createPostgresIntegrationDeliveryStore };
