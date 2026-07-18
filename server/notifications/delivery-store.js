'use strict';

/**
 * Notification delivery store — in-memory reference implementation of the
 * delivery-idempotency contract (ADR-0011).
 *
 * One logical customer notification exists per `notificationKey`, ever.
 * The claim/record semantics mirror the Consultation Summary delivery
 * claim (ADR-0006): a claim is granted when the key has never been
 * attempted, previously failed, or a prior 'pending' claim is stale
 * (claimant crashed mid-send); 'sent' is FINAL and never re-claimed —
 * this is what makes retries unable to duplicate a customer notification,
 * across restarts and API instances (the PostgreSQL implementation in
 * server/operational/notification-deliveries.js shares this contract).
 *
 * In-memory atomicity: one synchronous pass per operation, no `await`
 * in the middle — the platform's standard single-process guarantee.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

/**
 * @param {{ clock: import('../handoff/clock').Clock }} deps
 */
function createInMemoryNotificationDeliveryStore({ clock }) {
  /** @type {Map<string, { status: string, claimedAtMs: number|null }>} */
  const deliveries = new Map();

  return {
    /**
     * Atomically claim the right to deliver this notification.
     * @param {string} notificationKey
     * @returns {Promise<{ claimed: boolean, status: string|null }>}
     */
    async claim(notificationKey) {
      const now = clock.now();
      const existing = deliveries.get(notificationKey);
      const stale = existing && existing.status === 'pending'
        && typeof existing.claimedAtMs === 'number'
        && now - existing.claimedAtMs >= STALE_CLAIM_MS;

      if (!existing || existing.status === 'failed' || stale) {
        deliveries.set(notificationKey, { status: 'pending', claimedAtMs: now });
        return { claimed: true, status: 'pending' };
      }
      return { claimed: false, status: existing.status };
    },

    /**
     * Record the result of a claimed delivery attempt.
     * @param {string} notificationKey
     * @param {'sent'|'failed'|'not-configured'} status
     */
    async record(notificationKey, status) {
      deliveries.set(notificationKey, {
        status,
        claimedAtMs: (deliveries.get(notificationKey) || {}).claimedAtMs ?? null,
      });
      return { notificationKey, status };
    },

    /**
     * Operational visibility (ADR-0014): recent delivery records (keys and
     * statuses only — the store never holds content or recipients).
     * @param {{ limit?: number }} [options]
     */
    async listRecent({ limit = 50 } = {}) {
      const records = [...deliveries.entries()]
        .map(([notificationKey, record]) => ({ notificationKey, status: record.status, claimedAtMs: record.claimedAtMs }))
        .sort((a, b) => ((b.claimedAtMs ?? 0) - (a.claimedAtMs ?? 0)) || a.notificationKey.localeCompare(b.notificationKey));
      return records.slice(0, Math.max(1, limit));
    },

    /** Read a delivery record (tests/introspection). */
    async get(notificationKey) {
      const record = deliveries.get(notificationKey);
      return record ? { notificationKey, status: record.status } : undefined;
    },

    async close() {},
  };
}

module.exports = { createInMemoryNotificationDeliveryStore };
