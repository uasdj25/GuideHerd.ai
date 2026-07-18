'use strict';

/**
 * Integration delivery store — in-memory reference implementation of the
 * delivery-idempotency contract (ADR-0020).
 *
 * One logical system-to-system effect exists per `integrationKey`, ever.
 * The claim/record semantics are the platform's standard claim machine
 * (ADR-0006 / ADR-0011): a claim is granted when the key has never been
 * attempted, previously failed, or a prior 'pending' claim is stale
 * (claimant crashed mid-delivery); 'completed' is FINAL and never
 * re-claimed — retries cannot duplicate an effect in an external business
 * system, across restarts and API instances (the PostgreSQL
 * implementation in server/operational/integration-deliveries.js shares
 * this contract).
 *
 * Never stored here: request facts, provider payloads, customer data,
 * credentials. Keys carry GuideHerd identifiers only.
 *
 * In-memory atomicity: one synchronous pass per operation, no `await`
 * in the middle — the platform's standard single-process guarantee.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

/**
 * @param {{ clock: import('../handoff/clock').Clock }} deps
 */
function createInMemoryIntegrationDeliveryStore({ clock }) {
  /** @type {Map<string, { status: string, claimedAtMs: number|null }>} */
  const deliveries = new Map();

  return {
    /**
     * Atomically claim the right to deliver this integration effect.
     * @param {string} integrationKey
     * @returns {Promise<{ claimed: boolean, status: string|null }>}
     */
    async claim(integrationKey) {
      const now = clock.now();
      const existing = deliveries.get(integrationKey);
      const stale = existing && existing.status === 'pending'
        && typeof existing.claimedAtMs === 'number'
        && now - existing.claimedAtMs >= STALE_CLAIM_MS;

      if (!existing || existing.status === 'failed' || stale) {
        deliveries.set(integrationKey, { status: 'pending', claimedAtMs: now });
        return { claimed: true, status: 'pending' };
      }
      return { claimed: false, status: existing.status };
    },

    /**
     * Record the result of a claimed delivery attempt.
     * @param {string} integrationKey
     * @param {'completed'|'failed'|'not-configured'} status
     */
    async record(integrationKey, status) {
      deliveries.set(integrationKey, {
        status,
        claimedAtMs: (deliveries.get(integrationKey) || {}).claimedAtMs ?? null,
      });
      return { integrationKey, status };
    },

    /**
     * Operational visibility (ADR-0014): recent delivery records — keys
     * and statuses only; the store never holds facts or payloads.
     * @param {{ limit?: number }} [options]
     */
    async listRecent({ limit = 50 } = {}) {
      const records = [...deliveries.entries()]
        .map(([integrationKey, record]) => ({ integrationKey, status: record.status, claimedAtMs: record.claimedAtMs }))
        .sort((a, b) => ((b.claimedAtMs ?? 0) - (a.claimedAtMs ?? 0)) || a.integrationKey.localeCompare(b.integrationKey));
      return records.slice(0, Math.max(1, limit));
    },

    /** Read a delivery record (tests/introspection). */
    async get(integrationKey) {
      const record = deliveries.get(integrationKey);
      return record ? { integrationKey, status: record.status } : undefined;
    },

    async close() {},
  };
}

module.exports = { createInMemoryIntegrationDeliveryStore };
