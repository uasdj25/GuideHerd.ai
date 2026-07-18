'use strict';

/**
 * PostgreSQL notification delivery store (ADR-0011) — the durable
 * implementation of the delivery-idempotency contract in
 * server/notifications/delivery-store.js. Same semantics, made
 * multi-instance safe with one atomic conditional INSERT/UPDATE: across
 * any number of API instances, at most one concurrent caller holds the
 * claim for a notificationKey, and 'sent' is final forever.
 *
 * Timestamps come from the injected clock as bind parameters (ADR-0006
 * determinism discipline). Nothing sensitive is stored: keys carry
 * GuideHerd identifiers only.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresNotificationDeliveryStore({ pool, clock }) {
  return {
    async claim(notificationKey) {
      const now = new Date(clock.now());
      const staleBefore = new Date(clock.now() - STALE_CLAIM_MS);
      const { rows } = await pool.query(
        `INSERT INTO notification_deliveries (notification_key, status, claimed_at, created_at)
         VALUES ($1, 'pending', $2, $2)
         ON CONFLICT (notification_key) DO UPDATE
           SET status = 'pending', claimed_at = $2
           WHERE notification_deliveries.status = 'failed'
              OR (notification_deliveries.status = 'pending' AND notification_deliveries.claimed_at <= $3)
         RETURNING status`,
        [notificationKey, now, staleBefore],
      );
      if (rows.length === 1) return { claimed: true, status: 'pending' };
      const { rows: existing } = await pool.query(
        'SELECT status FROM notification_deliveries WHERE notification_key = $1',
        [notificationKey],
      );
      return { claimed: false, status: existing.length ? existing[0].status : null };
    },

    async record(notificationKey, status) {
      await pool.query(
        'UPDATE notification_deliveries SET status = $2 WHERE notification_key = $1',
        [notificationKey, status],
      );
      return { notificationKey, status };
    },

    async get(notificationKey) {
      const { rows } = await pool.query(
        'SELECT notification_key, status FROM notification_deliveries WHERE notification_key = $1',
        [notificationKey],
      );
      return rows.length ? { notificationKey: rows[0].notification_key, status: rows[0].status } : undefined;
    },

    /** The pool is owned by the handoff repository; nothing to drain here. */
    async close() {},
  };
}

module.exports = { createPostgresNotificationDeliveryStore };
