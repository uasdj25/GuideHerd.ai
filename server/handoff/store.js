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
 * In-memory handoff store.
 *
 * Two credentials exist per session, stored only as SHA-256 hashes:
 *  - handoff token  — redeems caller context exactly once (voice side)
 *  - console token  — status checks and cancellation only (receptionist side)
 * Neither can substitute for the other.
 *
 * Concurrency: Node runs JavaScript on a single thread and never preempts a
 * synchronous function. `redeem()` and `cancel()` each perform their
 * check-and-mark in one synchronous pass with no `await` in the middle, so a
 * concurrent redeem/redeem, cancel/cancel, or cancel/redeem race always
 * settles into exactly one terminal outcome.
 *
 * Expiration is lazy: sessions are marked expired when accessed; there is no
 * background scheduler in v1.
 *
 * The interface is intentionally small so a persistent store can replace it
 * later without touching services or controllers.
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
    create(session) {
      sessionsById.set(session.sessionId, session);
      tokenHashToSessionId.set(session.tokenHash, session.sessionId);
      return session;
    },

    /**
     * Atomically redeem a handoff token exactly once. Synchronous by design.
     * @param {string} tokenHash
     * @returns {import('./models').InternalSession}
     */
    redeem(tokenHash) {
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
    statusByConsole(sessionId, consoleTokenHash) {
      const session = requireConsoleAccess(sessionId, consoleTokenHash);
      markExpiredIfNeeded(session, clock.now());
      return session;
    },

    /**
     * Atomically cancel an awaiting-transfer session. Synchronous by design so
     * a concurrent redeem cannot interleave.
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
    cancel(sessionId, consoleTokenHash) {
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
     * Synchronous by design: concurrent connect attempts settle into exactly
     * one successful redemption.
     * @param {string} firmId
     * @returns {import('./models').InternalSession}
     */
    connectDemo(firmId) {
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
     * Synchronous by design (atomic under concurrency).
     * @param {string} sessionId
     * @param {{status: string, appointment?: object, schedulingSummary?: string,
     *          unresolvedQuestions?: string[], escalationRequired?: boolean}} outcome
     * @returns {{ session: import('./models').InternalSession, duplicate: boolean }}
     */
    applyOutcome(sessionId, outcome) {
      const session = sessionsById.get(sessionId);
      if (!session) throw new UnknownSessionError();
      const now = clock.now();

      const TERMINAL = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];
      if (TERMINAL.includes(session.status)) {
        // Idempotent only for an exactly identical outcome.
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
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * The most recently completed (booked/failed/escalated) session for a
     * firm, by completedAtMs — used only to display the latest Consultation
     * Summary during the demonstration. Returns undefined when none exist.
     * @param {string} firmId
     */
    latestCompleted(firmId) {
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
    get(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) return undefined;
      markExpiredIfNeeded(session, clock.now());
      return session;
    },

    size() {
      return sessionsById.size;
    },
  };
}

module.exports = { createInMemoryHandoffStore };
