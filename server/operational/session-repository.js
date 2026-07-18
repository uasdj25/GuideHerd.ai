'use strict';

/**
 * PostgreSQL Handoff repository — the durable implementation of the async
 * Handoff repository contract (ADR-0006). Behavior mirrors the in-memory
 * reference implementation in server/handoff/store.js transition for
 * transition; the shared contract suite runs against both.
 *
 * Atomicity: the in-memory store gets its guarantees from Node's
 * single-threaded synchronous execution. This implementation gets the SAME
 * guarantees — across multiple API instances sharing one database — from:
 *
 *  - conditional UPDATE ... WHERE status = ... RETURNING  (redeem, delivery
 *    claim): the database serializes writers on the row, so exactly one
 *    concurrent caller's predicate matches;
 *  - transactions with SELECT ... FOR UPDATE (connect, cancel, outcome):
 *    candidate rows are locked, the state machine's branch logic runs on the
 *    locked snapshot, and losers re-evaluate against the winner's committed
 *    state.
 *
 * Determinism: every timestamp comes from the injected clock and is passed
 * as a bind parameter — SQL now() is never used in transition logic — so the
 * fixed-clock test discipline applies to this implementation unchanged.
 *
 * Expiration stays lazy, exactly as in memory: awaiting-transfer rows past
 * expires_at are flipped to 'expired' when accessed; no background scheduler.
 *
 * Nothing sensitive is ever stored or logged here: raw tokens never reach
 * this module (hashes only), and errors are rethrown without bind values.
 */

const crypto = require('node:crypto');

const { SessionStatus } = require('../handoff/status');
const { STALE_CLAIM_MS, assertKnownCriteria } = require('../handoff/store');
const {
  UnknownTokenError,
  NoPreparedSessionError,
  AmbiguousSessionError,
  TooManyPreparedSessionsError,
  OutcomeConflictError,
  InvalidOutcomeStateError,
  TokenAlreadyRedeemedError,
  TokenExpiredError,
  TokenCancelledError,
  ForbiddenError,
  UnknownSessionError,
  CannotCancelError,
  SessionExpiredError,
} = require('../handoff/errors');

const TERMINAL = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];

/**
 * Advisory-lock namespace for the per-organization prepared-session cap
 * (two-key form, so it can never collide with the migration runner's
 * single-key lock 728301). The second key is hashtext(organization_key):
 * creates for the SAME organization serialize across all API instances;
 * unrelated organizations proceed in parallel. A rare hashtext collision
 * between organizations merely serializes them — never a correctness
 * issue. The lock is transaction-scoped: commit or rollback releases it.
 */
const PREPARED_CAP_LOCK_NAMESPACE = 728302;

/** Constant-time comparison of two hex digests (same as the in-memory store). */
function hashesEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** timestamptz -> epoch ms (or null). */
function ms(value) {
  return value === null || value === undefined ? null : new Date(value).getTime();
}

/** Map a handoff_sessions row to the InternalSession shape consumers expect. */
function toSession(row) {
  return {
    sessionId: row.session_id,
    firmId: row.organization_key,
    caller: {
      fullName: row.caller_full_name,
      email: row.caller_email,
      phone: row.caller_phone,
    },
    callerPhoneNormalized: row.caller_phone_normalized,
    scheduling: {
      attorneyId: row.attorney_id,
      practiceAreaId: row.practice_area_id,
      consultationTypeId: row.consultation_type_id,
    },
    handoff: {
      createdByUserId: row.created_by_user_id,
      source: row.handoff_source,
      mode: row.handoff_mode,
    },
    status: row.status,
    tokenHash: row.token_hash,
    consoleTokenHash: row.console_token_hash,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
    summaryDelivery: row.summary_delivery,
    summaryClaimedAtMs: ms(row.summary_claimed_at),
    redeemedAtMs: ms(row.connected_at),
    cancelledAtMs: ms(row.cancelled_at),
    completedAtMs: ms(row.completed_at),
    createdAtMs: ms(row.created_at),
    expiresAtMs: ms(row.expires_at),
  };
}

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresHandoffStore({ pool, clock }) {
  const nowDate = () => new Date(clock.now());

  /** Run `fn(client)` inside a transaction; roll back on any throw. */
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Lazily flip an awaiting-transfer row past its expiry to 'expired'.
   * Runs on the given client (inside a transaction) or the pool.
   */
  async function markExpiredIfNeeded(runner, sessionId, now) {
    await runner.query(
      `UPDATE handoff_sessions SET status = 'expired', version = version + 1
        WHERE session_id = $1 AND status = 'awaiting-transfer' AND expires_at <= $2`,
      [sessionId, now],
    );
  }

  /** Fetch one row (optionally FOR UPDATE on a transaction client). */
  async function fetchRow(runner, sessionId, forUpdate = false) {
    const { rows } = await runner.query(
      `SELECT * FROM handoff_sessions WHERE session_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    return rows[0];
  }

  /** Insert a session row on the given runner (pool or transaction client). */
  async function insertSession(runner, session) {
    await runner.query(
      `INSERT INTO handoff_sessions (
           session_id, organization_key, status,
           caller_full_name, caller_email, caller_phone, caller_phone_normalized,
           attorney_id, practice_area_id, consultation_type_id,
           handoff_source, handoff_mode, created_by_user_id,
           token_hash, console_token_hash,
           outcome_json, summary_delivery, summary_claimed_at,
           created_at, expires_at, connected_at, completed_at, cancelled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          session.sessionId, session.firmId, session.status,
          session.caller.fullName, session.caller.email, session.caller.phone ?? null,
          session.callerPhoneNormalized ?? null,
          session.scheduling.attorneyId ?? null, session.scheduling.practiceAreaId ?? null,
          session.scheduling.consultationTypeId,
          session.handoff.source, session.handoff.mode, session.handoff.createdByUserId ?? null,
          session.tokenHash, session.consoleTokenHash,
          session.outcome === null ? null : JSON.stringify(session.outcome),
          session.summaryDelivery ?? null,
          session.summaryClaimedAtMs === null || session.summaryClaimedAtMs === undefined
            ? null : new Date(session.summaryClaimedAtMs),
          new Date(session.createdAtMs), new Date(session.expiresAtMs),
          session.redeemedAtMs === null ? null : new Date(session.redeemedAtMs),
          session.completedAtMs === null ? null : new Date(session.completedAtMs),
          session.cancelledAtMs === null ? null : new Date(session.cancelledAtMs),
        ],
      );
    }

  const api = {
    /**
     * Create a session. With `maxEligiblePrepared`, atomically enforce the
     * per-organization cap on eligible (awaiting-transfer, unexpired)
     * prepared sessions (ADR-0010) ACROSS INSTANCES: a transaction-scoped
     * advisory lock keyed by the organization serializes same-organization
     * creates, so the count and the insert are one atomic unit and the cap
     * can never be overshot; unrelated organizations are not serialized.
     * Expired, cancelled, connected, and terminal rows never consume
     * capacity. Throws 429 when full (rollback: nothing inserted).
     * @param {import('../handoff/models').InternalSession} session
     * @param {{ maxEligiblePrepared?: number }} [options]
     */
    async create(session, { maxEligiblePrepared } = {}) {
      if (maxEligiblePrepared === undefined || session.status !== SessionStatus.AWAITING_TRANSFER) {
        await insertSession(pool, session);
        return session;
      }
      const now = nowDate();
      return inTransaction(async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock($1, hashtext($2))',
          [PREPARED_CAP_LOCK_NAMESPACE, session.firmId],
        );
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM handoff_sessions
            WHERE organization_key = $1 AND status = 'awaiting-transfer' AND expires_at > $2`,
          [session.firmId, now],
        );
        if (rows[0].n >= maxEligiblePrepared) throw new TooManyPreparedSessionsError();
        await insertSession(client, session);
        return session;
      });
    },

    /**
     * Atomically redeem a handoff token exactly once: a single conditional
     * UPDATE — the database guarantees at most one concurrent caller matches
     * the awaiting-transfer predicate, across any number of API instances.
     */
    async redeem(tokenHash) {
      const now = nowDate();
      const { rows } = await pool.query(
        `UPDATE handoff_sessions
            SET status = 'connected', connected_at = $2, version = version + 1
          WHERE token_hash = $1 AND status = 'awaiting-transfer' AND expires_at > $2
          RETURNING *`,
        [tokenHash, now],
      );
      if (rows.length === 1) return toSession(rows[0]);

      // Losing paths are all terminal for this token, so a classification
      // read is safe. Order mirrors the in-memory store exactly.
      const { rows: existing } = await pool.query(
        'SELECT * FROM handoff_sessions WHERE token_hash = $1', [tokenHash],
      );
      if (existing.length === 0) throw new UnknownTokenError();
      const row = existing[0];
      if (row.status === SessionStatus.CANCELLED) throw new TokenCancelledError();
      if (row.status === SessionStatus.EXPIRED || new Date(row.expires_at) <= now) {
        await markExpiredIfNeeded(pool, row.session_id, now);
        throw new TokenExpiredError();
      }
      throw new TokenAlreadyRedeemedError();
    },

    async statusByConsole(sessionId, consoleTokenHash) {
      const now = nowDate();
      const row = await fetchRow(pool, sessionId);
      if (!row) throw new UnknownSessionError();
      if (!hashesEqual(row.console_token_hash, consoleTokenHash)) throw new ForbiddenError();
      await markExpiredIfNeeded(pool, sessionId, now);
      return toSession((await fetchRow(pool, sessionId)));
    },

    /**
     * Cancel with the exact in-memory branch semantics, made multi-instance
     * safe by locking the row (FOR UPDATE): a concurrent redeem on another
     * instance either commits first (this sees CONNECTED -> 409) or blocks
     * until this cancel commits (it then sees CANCELLED -> 410).
     */
    async cancel(sessionId, consoleTokenHash) {
      const now = nowDate();
      return inTransaction(async (client) => {
        const row = await fetchRow(client, sessionId, true);
        if (!row) throw new UnknownSessionError();
        if (!hashesEqual(row.console_token_hash, consoleTokenHash)) throw new ForbiddenError();

        const expired = new Date(row.expires_at) <= now;
        let status = row.status;
        if (status === SessionStatus.AWAITING_TRANSFER && expired) {
          await markExpiredIfNeeded(client, sessionId, now);
          status = SessionStatus.EXPIRED;
        }

        if (status === SessionStatus.CANCELLED) {
          if (expired) throw new SessionExpiredError();
          return toSession(row); // idempotent repeat cancel within the lifetime
        }
        if (status === SessionStatus.CONNECTED) throw new CannotCancelError();
        if (status === SessionStatus.EXPIRED) throw new SessionExpiredError();

        const { rows } = await client.query(
          `UPDATE handoff_sessions
              SET status = 'cancelled', cancelled_at = $2, version = version + 1
            WHERE session_id = $1 RETURNING *`,
          [sessionId, now],
        );
        return toSession(rows[0]);
      });
    },

    /**
     * Atomically connect the ONE eligible prepared session matching the
     * candidate criteria — the storage primitive beneath the Correlation
     * Engine, multi-instance safe: candidates are locked FOR UPDATE inside
     * one transaction, so concurrent connect attempts — on any instances —
     * serialize, and each session is redeemed at most once. Criteria on
     * DIFFERENT sessions lock disjoint rows, so concurrent connects for
     * different callers proceed in parallel.
     *
     * Every criterion is ANDed inside the organization scope — matching can
     * never cross organizations. Unknown criteria keys are rejected loudly
     * (shared allowlist with the in-memory reference implementation).
     * The candidate scan is served by idx_handoff_sessions_eligibility, and
     * phone criteria by the partial idx_handoff_sessions_phone.
     * @param {string} firmId
     * @param {{ sessionId?: string, callerPhoneNormalized?: string }} [criteria]
     */
    async connectEligible(firmId, criteria = {}) {
      assertKnownCriteria(criteria);
      const now = nowDate();
      return inTransaction(async (client) => {
        // Lazy expiry first, exactly as the in-memory scan does.
        await client.query(
          `UPDATE handoff_sessions SET status = 'expired', version = version + 1
            WHERE organization_key = $1 AND status = 'awaiting-transfer' AND expires_at <= $2`,
          [firmId, now],
        );
        const conditions = ["organization_key = $1", "status = 'awaiting-transfer'"];
        const params = [firmId];
        if (criteria.sessionId !== undefined) {
          params.push(criteria.sessionId);
          conditions.push(`session_id = $${params.length}`);
        }
        if (criteria.callerPhoneNormalized !== undefined) {
          params.push(criteria.callerPhoneNormalized);
          conditions.push(`caller_phone_normalized = $${params.length}`);
        }
        const { rows } = await client.query(
          `SELECT * FROM handoff_sessions
            WHERE ${conditions.join(' AND ')}
            FOR UPDATE`,
          params,
        );
        if (rows.length === 0) throw new NoPreparedSessionError();
        if (rows.length > 1) throw new AmbiguousSessionError(); // rollback: none redeemed

        const { rows: updated } = await client.query(
          `UPDATE handoff_sessions
              SET status = 'connected', connected_at = $2, version = version + 1
            WHERE session_id = $1 RETURNING *`,
          [rows[0].session_id, now],
        );
        return toSession(updated[0]);
      });
    },

    /**
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * The criteria-less baseline of connectEligible, kept as a named method
     * while the demo bridge exists.
     */
    async connectDemo(firmId) {
      return api.connectEligible(firmId, {});
    },

    /**
     * Count the organization's eligible (awaiting-transfer, unexpired)
     * prepared sessions — served by idx_handoff_sessions_eligibility. The
     * per-organization cap reads this before create (ADR-0010); the check
     * is deliberately advisory (no lock), so a cross-instance race can
     * overshoot by a request or two — acceptable for abuse containment.
     * @param {string} firmId
     */
    async countEligible(firmId) {
      const now = nowDate();
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM handoff_sessions
          WHERE organization_key = $1 AND status = 'awaiting-transfer' AND expires_at > $2`,
        [firmId, now],
      );
      return rows[0].n;
    },

    /**
     * First terminal outcome wins; identical duplicates are idempotent;
     * conflicts are rejected without mutation. The row lock makes the
     * read-compare-write atomic across instances.
     */
    async applyOutcome(sessionId, outcome) {
      const now = nowDate();
      return inTransaction(async (client) => {
        const row = await fetchRow(client, sessionId, true);
        if (!row) throw new UnknownSessionError();

        if (TERMINAL.includes(row.status)) {
          // outcome_json stores the canonical normalized serialization, so
          // duplicate detection is exact string equality (same rule as the
          // in-memory JSON.stringify comparison).
          if (row.outcome_json === JSON.stringify(outcome)) {
            return { session: toSession(row), duplicate: true };
          }
          throw new OutcomeConflictError();
        }
        if (row.status !== SessionStatus.CONNECTED && row.status !== SessionStatus.SCHEDULING) {
          throw new InvalidOutcomeStateError();
        }

        const { rows } = await client.query(
          `UPDATE handoff_sessions
              SET status = $2, outcome_json = $3, completed_at = $4, version = version + 1
            WHERE session_id = $1 RETURNING *`,
          [sessionId, outcome.status, JSON.stringify(outcome), now],
        );
        return { session: toSession(rows[0]), duplicate: false };
      });
    },

    /**
     * Atomically claim the summary-delivery right: one conditional UPDATE,
     * so concurrent duplicate outcome requests — including on different API
     * instances — can never both hold the claim. Grantable when never
     * attempted, previously failed, or a prior 'pending' claim is stale.
     * Never re-grants after 'sent'.
     */
    async claimSummaryDelivery(sessionId) {
      const now = nowDate();
      const staleBefore = new Date(clock.now() - STALE_CLAIM_MS);
      const { rows } = await pool.query(
        `UPDATE handoff_sessions
            SET summary_delivery = 'pending', summary_claimed_at = $2, version = version + 1
          WHERE session_id = $1
            AND (summary_delivery IS NULL
                 OR summary_delivery = 'failed'
                 OR (summary_delivery = 'pending' AND summary_claimed_at <= $3))
          RETURNING *`,
        [sessionId, now, staleBefore],
      );
      if (rows.length === 1) {
        return { claimed: true, summaryDelivery: 'pending', session: toSession(rows[0]) };
      }
      const row = await fetchRow(pool, sessionId);
      if (!row) throw new UnknownSessionError();
      return { claimed: false, summaryDelivery: row.summary_delivery, session: toSession(row) };
    },

    async recordSummaryDelivery(sessionId, deliveryStatus) {
      const { rows } = await pool.query(
        `UPDATE handoff_sessions
            SET summary_delivery = $2, version = version + 1
          WHERE session_id = $1 RETURNING *`,
        [sessionId, deliveryStatus],
      );
      if (rows.length === 0) throw new UnknownSessionError();
      return toSession(rows[0]);
    },

    /**
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * Most recently completed terminal session for a firm.
     */
    async latestCompleted(firmId) {
      const { rows } = await pool.query(
        `SELECT * FROM handoff_sessions
          WHERE organization_key = $1 AND status IN ('booked','failed','escalated')
          ORDER BY completed_at DESC NULLS LAST
          LIMIT 1`,
        [firmId],
      );
      return rows.length === 0 ? undefined : toSession(rows[0]);
    },

    /** Read a session (marks it expired if its time has passed). */
    async get(sessionId) {
      const now = nowDate();
      const row = await fetchRow(pool, sessionId);
      if (!row) return undefined;
      if (row.status === SessionStatus.AWAITING_TRANSFER && new Date(row.expires_at) <= now) {
        await markExpiredIfNeeded(pool, sessionId, now);
        return toSession(await fetchRow(pool, sessionId));
      }
      return toSession(row);
    },

    async size() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM handoff_sessions');
      return rows[0].n;
    },

    /** Drain the pool. The repository owns its pool. */
    async close() {
      await pool.end();
    },
  };
  return api;
}

module.exports = { createPostgresHandoffStore };
