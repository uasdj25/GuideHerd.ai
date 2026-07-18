'use strict';

/**
 * The GuideHerd delivery-claim core (ADR-0011 / ADR-0020 §"shared
 * mechanics") — the ONE implementation of the platform's delivery
 * idempotency machine, used by both the Notification and Integration
 * delivery stores so the two can never drift.
 *
 * What is shared here is MECHANICS only, because it is genuinely
 * identical between the two contracts:
 *
 *   - first claim wins; a fresh 'pending' claim blocks
 *   - a FINAL status is never re-claimed, ever (the exactly-once effect)
 *   - 'failed' is re-claimable (recovery can retry)
 *   - a stale 'pending' claim (claimant crashed) recovers after
 *     STALE_CLAIM_MS
 *   - records hold key + status + claim timestamp ONLY — never payloads,
 *     recipients, facts, or customer data
 *   - the PostgreSQL implementation is one atomic conditional
 *     INSERT/UPDATE, multi-instance safe
 *
 * What deliberately stays OUTSIDE this core, in the owning contracts:
 * request validation, provider contracts, status vocabularies beyond the
 * machine's own ('pending'/'failed' + the domain's final status), retry
 * POLICY (bounded attempts live in the callers — outbox consumers,
 * scheduler handlers, workflow steps — and duplication-safe retry
 * classification lives in provider boundaries), and telemetry. The public
 * store contracts remain separate and domain-named; they are thin
 * field-mapping wrappers over this core.
 *
 * Table/column identifiers in the PostgreSQL core are compile-time
 * constants supplied by the wrappers — never runtime input.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

/**
 * In-memory claim core. One synchronous pass per operation, no `await`
 * mid-operation — the platform's standard single-process atomicity.
 *
 * @param {{ clock: import('../handoff/clock').Clock, finalStatus: string }} deps
 */
function createInMemoryClaimCore({ clock, finalStatus }) {
  /** @type {Map<string, { status: string, claimedAtMs: number|null }>} */
  const records = new Map();

  return {
    async claim(key) {
      const now = clock.now();
      const existing = records.get(key);
      const stale = existing && existing.status === 'pending'
        && typeof existing.claimedAtMs === 'number'
        && now - existing.claimedAtMs >= STALE_CLAIM_MS;

      if (!existing || existing.status === 'failed' || stale) {
        records.set(key, { status: 'pending', claimedAtMs: now });
        return { claimed: true, status: 'pending' };
      }
      return { claimed: false, status: existing.status };
    },

    async record(key, status) {
      records.set(key, {
        status,
        claimedAtMs: (records.get(key) || {}).claimedAtMs ?? null,
      });
      return { key, status };
    },

    async listRecent({ limit = 50 } = {}) {
      return [...records.entries()]
        .map(([key, record]) => ({ key, status: record.status, claimedAtMs: record.claimedAtMs }))
        .sort((a, b) => ((b.claimedAtMs ?? 0) - (a.claimedAtMs ?? 0)) || a.key.localeCompare(b.key))
        .slice(0, Math.max(1, limit));
    },

    async get(key) {
      const record = records.get(key);
      return record ? { key, status: record.status } : undefined;
    },

    async close() {},
    finalStatus,
  };
}

/**
 * PostgreSQL claim core: the atomic conditional INSERT/UPDATE proven by
 * the notification store (ADR-0011). Across any number of API instances,
 * at most one concurrent caller holds the claim for a key, and the final
 * status is final forever. Timestamps are injected-clock bind parameters
 * (ADR-0006 determinism discipline).
 *
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock,
 *           table: string, keyColumn: string, finalStatus: string }} deps
 *        `table`/`keyColumn` are wrapper-supplied constants.
 */
function createPostgresClaimCore({ pool, clock, table, keyColumn, finalStatus }) {
  return {
    async claim(key) {
      const now = new Date(clock.now());
      const staleBefore = new Date(clock.now() - STALE_CLAIM_MS);
      const { rows } = await pool.query(
        `INSERT INTO ${table} (${keyColumn}, status, claimed_at, created_at)
         VALUES ($1, 'pending', $2, $2)
         ON CONFLICT (${keyColumn}) DO UPDATE
           SET status = 'pending', claimed_at = $2
           WHERE ${table}.status = 'failed'
              OR (${table}.status = 'pending' AND ${table}.claimed_at <= $3)
         RETURNING status`,
        [key, now, staleBefore],
      );
      if (rows.length === 1) return { claimed: true, status: 'pending' };
      const { rows: existing } = await pool.query(
        `SELECT status FROM ${table} WHERE ${keyColumn} = $1`,
        [key],
      );
      return { claimed: false, status: existing.length ? existing[0].status : null };
    },

    async record(key, status) {
      await pool.query(
        `UPDATE ${table} SET status = $2 WHERE ${keyColumn} = $1`,
        [key, status],
      );
      return { key, status };
    },

    async listRecent({ limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT ${keyColumn} AS key, status, claimed_at FROM ${table}
          ORDER BY claimed_at DESC NULLS LAST, ${keyColumn} ASC
          LIMIT $1`,
        [Math.max(1, limit)],
      );
      return rows.map((r) => ({
        key: r.key,
        status: r.status,
        claimedAtMs: r.claimed_at === null ? null : new Date(r.claimed_at).getTime(),
      }));
    },

    async get(key) {
      const { rows } = await pool.query(
        `SELECT ${keyColumn} AS key, status FROM ${table} WHERE ${keyColumn} = $1`,
        [key],
      );
      return rows.length ? { key: rows[0].key, status: rows[0].status } : undefined;
    },

    /** Pools are owned by the composing repository; nothing to drain. */
    async close() {},
    finalStatus,
  };
}

/**
 * Wrap a claim core in a domain-named public contract: the records carry
 * the domain's key field name (`notificationKey` / `integrationKey`), so
 * callers and operational views keep their domain vocabulary.
 */
function withKeyField(core, keyField) {
  const rename = (r) => (r === undefined ? undefined : (({ key, ...rest }) => ({ [keyField]: key, ...rest }))(r));
  return {
    claim: (key) => core.claim(key),
    record: (key, status) => core.record(key, status).then((r) => rename(r)),
    listRecent: (options) => core.listRecent(options).then((rows) => rows.map(rename)),
    get: (key) => core.get(key).then((r) => rename(r)),
    close: () => core.close(),
  };
}

module.exports = { createInMemoryClaimCore, createPostgresClaimCore, withKeyField };
