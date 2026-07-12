'use strict';

const { SessionStatus } = require('./status');
const { UnknownTokenError, TokenAlreadyRedeemedError, TokenExpiredError } = require('./errors');

/**
 * In-memory handoff store.
 *
 * Concurrency: Node runs JavaScript on a single thread and never preempts a
 * synchronous function. `redeem()` performs its check-and-mark in one
 * synchronous pass with no `await` in the middle, so two concurrent requests
 * cannot both pass the "not yet redeemed" check — exactly one wins and the rest
 * see a conflict. This is the whole single-use guarantee.
 *
 * Expiration is lazy: sessions are marked expired when accessed (on redeem or
 * get); there is no background scheduler in v1.
 *
 * The interface (create / redeem / get) is intentionally small so a persistent
 * store can replace it later without touching services or controllers.
 *
 * @param {{ clock: import('./clock').Clock }} deps
 */
function createInMemoryHandoffStore({ clock }) {
  /** @type {Map<string, import('./models').InternalSession>} */
  const sessionsById = new Map();
  /** @type {Map<string, string>} tokenHash -> sessionId */
  const tokenHashToSessionId = new Map();

  function isExpired(session, now) {
    return now >= session.expiresAtMs;
  }

  function markExpiredIfNeeded(session, now) {
    if (session.status === SessionStatus.AWAITING_TRANSFER && isExpired(session, now)) {
      session.status = SessionStatus.EXPIRED;
    }
  }

  return {
    /** @param {import('./models').InternalSession} session */
    create(session) {
      sessionsById.set(session.sessionId, session);
      tokenHashToSessionId.set(session.tokenHash, session.sessionId);
      return session;
    },

    /**
     * Atomically redeem a token exactly once. Synchronous by design.
     * @param {string} tokenHash
     * @returns {import('./models').InternalSession}
     */
    redeem(tokenHash) {
      const now = clock.now();
      const sessionId = tokenHashToSessionId.get(tokenHash);
      if (!sessionId) throw new UnknownTokenError();

      const session = sessionsById.get(sessionId);
      if (!session) throw new UnknownTokenError();

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
