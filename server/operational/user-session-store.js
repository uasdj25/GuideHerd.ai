'use strict';

/**
 * PostgreSQL user-session store (ADR-0013 / GitLab #64) — the durable
 * implementation of the session-store contract
 * (`create`/`get`/`delete`/`size`), following ADR-0006's operational-store
 * patterns. The in-memory implementation in identity/user-sessions.js
 * remains the default and the test reference; server.js selects this one
 * under `GUIDEHERD_OPERATIONAL_PROVIDER=postgres`, the same switch that
 * governs every other durable store.
 *
 * Semantics preserved exactly (and re-proven by the shared lifecycle
 * suite): hash-keyed rows (never a raw token), lazy absolute expiry (an
 * expired row is deleted on access and never returned), immediate
 * delete-on-logout/rotation. Additionally, create() purges expired rows
 * — every login bounds the table without a background sweeper.
 *
 * The stored identity is re-frozen on read so the service's "sessions
 * hold the frozen validated identity" guarantee holds across the JSON
 * round trip.
 */

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresUserSessionStore({ pool, clock }) {
  const freezeIdentity = (identity) => Object.freeze({
    ...identity,
    roles: Object.freeze([...identity.roles]),
  });

  return {
    async create(tokenHash, record) {
      // Opportunistic purge: logins are the natural cleanup cadence.
      await pool.query('DELETE FROM user_sessions WHERE expires_at_ms <= $1', [clock.now()]);
      await pool.query(
        `INSERT INTO user_sessions (token_hash, identity_json, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_hash) DO UPDATE
           SET identity_json = EXCLUDED.identity_json,
               created_at_ms = EXCLUDED.created_at_ms,
               expires_at_ms = EXCLUDED.expires_at_ms`,
        [tokenHash, JSON.stringify(record.identity), record.createdAtMs, record.expiresAtMs],
      );
    },

    /** Lazy expiry: an expired record is removed on access. */
    async get(tokenHash) {
      const { rows } = await pool.query(
        'SELECT identity_json, created_at_ms, expires_at_ms FROM user_sessions WHERE token_hash = $1',
        [tokenHash],
      );
      if (rows.length === 0) return undefined;
      const row = rows[0];
      const expiresAtMs = Number(row.expires_at_ms);
      if (clock.now() >= expiresAtMs) {
        await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
        return undefined;
      }
      return {
        identity: freezeIdentity(JSON.parse(row.identity_json)),
        createdAtMs: Number(row.created_at_ms),
        expiresAtMs,
      };
    },

    async delete(tokenHash) {
      await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
    },

    /** Live (non-expired) session count — observability/tests only. */
    async size() {
      const { rows } = await pool.query(
        'SELECT COUNT(*) AS n FROM user_sessions WHERE expires_at_ms > $1', [clock.now()],
      );
      return Number(rows[0].n);
    },
  };
}

module.exports = { createPostgresUserSessionStore };
