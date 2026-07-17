'use strict';

const crypto = require('node:crypto');

const { SessionStatus } = require('./status');
const {
  UnknownTokenError,
  NoPreparedSessionError,
  AmbiguousSessionError,
  OutcomeConflictError,
  InvalidOutcomeStateError,
  TokenAlreadyRedeemedError,
  TokenExpiredError,
  TokenCancelledError,
  ForbiddenError,
  UnknownSessionError,
  CannotCancelError,
  SessionExpiredError,
} = require('./errors');

/** Constant-time comparison of two hex digests. */
function hashesEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * A summary-delivery claim stuck in 'pending' longer than this is considered
 * abandoned (claimant crashed mid-send) and may be re-claimed. Trades a rare
 * duplicate email after a crash for never-permanently-stuck retries.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * In-memory handoff repository — the reference implementation of the async
 * Handoff repository contract (ADR-0006). The PostgreSQL implementation in
 * server/operational/session-repository.js implements the same contract;
 * the shared contract suite in server/operational/contract-suite.js runs
 * against both.
 *
 * Two credentials exist per session, stored only as SHA-256 hashes:
 *  - handoff token  — redeems caller context exactly once (voice side)
 *  - console token  — status checks and cancellation only (receptionist side)
 * Neither can substitute for the other.
 *
 * Concurrency (in-memory): methods are async to honor the repository
 * contract, but each transition's check-and-mark still runs synchronously
 * with no `await` in the middle — Node never preempts synchronous code, so a
 * concurrent redeem/redeem, cancel/cancel, or cancel/redeem race settles
 * into exactly one terminal outcome, exactly as before the contract became
 * async. (The PostgreSQL implementation derives the same guarantees from
 * transactions and conditional updates instead.)
 *
 * Expiration is lazy: sessions are marked expired when accessed; there is no
 * background scheduler.
 *
 * @param {{ clock: import('./clock').Clock }} deps
 */
function createInMemoryHandoffStore({ clock }) {
  /** @type {Map<string, import('./models').InternalSession>} */
  const sessionsById = new Map();
  /** @type {Map<string, string>} handoff tokenHash -> sessionId */
  const tokenHashToSessionId = new Map();

  function isExpired(session, now) {
    return now >= session.expiresAtMs;
  }

  function markExpiredIfNeeded(session, now) {
    if (session.status === SessionStatus.AWAITING_TRANSFER && isExpired(session, now)) {
      session.status = SessionStatus.EXPIRED;
    }
  }

  /** Authenticate a console token against a session; throws 404/403. */
  function requireConsoleAccess(sessionId, consoleTokenHash) {
    const session = sessionsById.get(sessionId);
    if (!session) throw new UnknownSessionError();
    if (!hashesEqual(session.consoleTokenHash, consoleTokenHash)) {
      throw new ForbiddenError();
    }
    return session;
  }

  return {
    /** @param {import('./models').InternalSession} session */
    async create(session) {
      sessionsById.set(session.sessionId, session);
      tokenHashToSessionId.set(session.tokenHash, session.sessionId);
      return session;
    },

    /**
     * Atomically redeem a handoff token exactly once.
     * @param {string} tokenHash
     * @returns {Promise<import('./models').InternalSession>}
     */
    async redeem(tokenHash) {
      const now = clock.now();
      const sessionId = tokenHashToSessionId.get(tokenHash);
      if (!sessionId) throw new UnknownTokenError();

      const session = sessionsById.get(sessionId);
      if (!session) throw new UnknownTokenError();

      // A cancelled session invalidates its handoff token permanently.
      if (session.status === SessionStatus.CANCELLED) {
        throw new TokenCancelledError();
      }

      markExpiredIfNeeded(session, now);
      if (session.status === SessionStatus.EXPIRED || isExpired(session, now)) {
        throw new TokenExpiredError();
      }
      if (session.redeemedAtMs !== null || session.status !== SessionStatus.AWAITING_TRANSFER) {
        throw new TokenAlreadyRedeemedError();
      }

      session.redeemedAtMs = now;
      session.status = SessionStatus.CONNECTED;
      return session;
    },

    /**
     * Read status with console-token authorization. Returns the session after
     * lazy expiry evaluation; caller context is filtered out by the service.
     * @param {string} sessionId
     * @param {string} consoleTokenHash
     */
    async statusByConsole(sessionId, consoleTokenHash) {
      const session = requireConsoleAccess(sessionId, consoleTokenHash);
      markExpiredIfNeeded(session, clock.now());
      return session;
    },

    /**
     * Atomically cancel an awaiting-transfer session (one synchronous pass,
     * so a concurrent redeem cannot interleave).
     *
     * Credential semantics (see docs/api/context-handoff.md):
     *  - Cancellation IMMEDIATELY and permanently invalidates the handoff
     *    token: redeem() rejects CANCELLED sessions with 410 token_cancelled.
     *  - The console token is NOT invalidated by cancellation. It remains a
     *    read/cancel-only credential: it can read the terminal status, and —
     *    until the session's original expiry time — receive an idempotent
     *    cancelled response for repeat cancels. It can never redeem caller
     *    context or cause any further transition.
     *
     * Outcomes:
     *  - awaiting-transfer          -> cancelled
     *  - already cancelled, pre-expiry  -> idempotent success (200)
     *  - already cancelled, post-expiry -> 410 session_expired
     *  - connected                  -> 409 cannot_cancel
     *  - expired (never cancelled)  -> 410 session_expired
     * @param {string} sessionId
     * @param {string} consoleTokenHash
     */
    async cancel(sessionId, consoleTokenHash) {
      const session = requireConsoleAccess(sessionId, consoleTokenHash);
      const now = clock.now();
      markExpiredIfNeeded(session, now);

      if (session.status === SessionStatus.CANCELLED) {
        if (isExpired(session, now)) throw new SessionExpiredError();
        return session; // idempotent repeat cancel within the session lifetime
      }
      if (session.status === SessionStatus.CONNECTED) {
        throw new CannotCancelError();
      }
      if (session.status === SessionStatus.EXPIRED) {
        throw new SessionExpiredError();
      }

      session.status = SessionStatus.CANCELLED;
      session.cancelledAtMs = now;
      return session;
    },

    /**
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * Connect the single eligible prepared session for a firm — the
     * server-held equivalent of handoff-token redemption. Eligible means
     * status awaiting-transfer, unexpired, matching firmId.
     *  - zero eligible   -> 404 no_prepared_session
     *  - more than one   -> 409 ambiguous_prepared_sessions (redeems none;
     *    deliberately favors safety over convenience)
     *  - exactly one     -> atomically redeemed (same single-use semantics)
     * One synchronous pass: concurrent connect attempts settle into exactly
     * one successful redemption.
     * @param {string} firmId
     * @returns {Promise<import('./models').InternalSession>}
     */
    async connectDemo(firmId) {
      const now = clock.now();
      const eligible = [];
      for (const session of sessionsById.values()) {
        markExpiredIfNeeded(session, now);
        if (session.firmId === firmId && session.status === SessionStatus.AWAITING_TRANSFER) {
          eligible.push(session);
        }
      }
      if (eligible.length === 0) throw new NoPreparedSessionError();
      if (eligible.length > 1) throw new AmbiguousSessionError();

      const session = eligible[0];
      session.redeemedAtMs = now;
      session.status = SessionStatus.CONNECTED;
      return session;
    },

    /**
     * Record a terminal scheduling outcome reported by the assistant.
     *  - only CONNECTED or SCHEDULING sessions may accept an outcome;
     *  - the first valid terminal outcome wins;
     *  - an exactly identical duplicate is idempotent;
     *  - a conflicting later outcome -> 409 outcome_conflict;
     *  - invalid transitions never mutate the session.
     * One synchronous pass (atomic under concurrency).
     * @param {string} sessionId
     * @param {{status: string, appointment?: object, schedulingSummary?: string,
     *          unresolvedQuestions?: string[], escalationRequired?: boolean}} outcome
     * @returns {Promise<{ session: import('./models').InternalSession, duplicate: boolean }>}
     */
    async applyOutcome(sessionId, outcome) {
      const session = sessionsById.get(sessionId);
      if (!session) throw new UnknownSessionError();
      const now = clock.now();

      const TERMINAL = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];
      if (TERMINAL.includes(session.status)) {
        // Idempotent only for an exactly identical outcome. Both objects are
        // service-normalized, so serialization is deterministic.
        if (JSON.stringify(session.outcome) === JSON.stringify(outcome)) {
          return { session, duplicate: true };
        }
        throw new OutcomeConflictError();
      }
      if (session.status !== SessionStatus.CONNECTED && session.status !== SessionStatus.SCHEDULING) {
        // cancelled / expired / awaiting-transfer sessions never mutate here
        throw new InvalidOutcomeStateError();
      }

      session.status = outcome.status;
      session.outcome = outcome;
      session.completedAtMs = now;
      return { session, duplicate: false };
    },

    /**
     * Atomically claim the right to deliver the Consultation Summary.
     * Grantable when delivery has never been attempted (null), previously
     * failed, or a prior 'pending' claim is stale (claimant crashed
     * mid-send). One synchronous pass: concurrent duplicate outcome requests
     * can never both hold the claim. Never re-grants after 'sent'.
     * @param {string} sessionId
     * @returns {Promise<{claimed: boolean, summaryDelivery: string|null,
     *                    session: import('./models').InternalSession}>}
     */
    async claimSummaryDelivery(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) throw new UnknownSessionError();
      const now = clock.now();

      const stale = session.summaryDelivery === 'pending'
        && typeof session.summaryClaimedAtMs === 'number'
        && now - session.summaryClaimedAtMs >= STALE_CLAIM_MS;

      if (session.summaryDelivery === null || session.summaryDelivery === 'failed' || stale) {
        session.summaryDelivery = 'pending';
        session.summaryClaimedAtMs = now;
        return { claimed: true, summaryDelivery: 'pending', session };
      }
      return { claimed: false, summaryDelivery: session.summaryDelivery, session };
    },

    /**
     * Record the result of a claimed delivery attempt.
     * @param {string} sessionId
     * @param {'sent'|'failed'|'not-configured'} deliveryStatus
     */
    async recordSummaryDelivery(sessionId, deliveryStatus) {
      const session = sessionsById.get(sessionId);
      if (!session) throw new UnknownSessionError();
      session.summaryDelivery = deliveryStatus;
      return session;
    },

    /**
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * The most recently completed (booked/failed/escalated) session for a
     * firm, by completedAtMs — used only to display the latest Consultation
     * Summary during the demonstration. Returns undefined when none exist.
     * @param {string} firmId
     */
    async latestCompleted(firmId) {
      const TERMINAL = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];
      let latest;
      for (const session of sessionsById.values()) {
        if (session.firmId !== firmId || !TERMINAL.includes(session.status)) continue;
        if (!latest || (session.completedAtMs ?? 0) > (latest.completedAtMs ?? 0)) {
          latest = session;
        }
      }
      return latest;
    },

    /** Read a session (marks it expired if its time has passed). For tests/introspection. */
    async get(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) return undefined;
      markExpiredIfNeeded(session, clock.now());
      return session;
    },

    async size() {
      return sessionsById.size;
    },

    /** Release resources. No-op for the in-memory implementation. */
    async close() {},
  };
}

module.exports = { createInMemoryHandoffStore, STALE_CLAIM_MS };
