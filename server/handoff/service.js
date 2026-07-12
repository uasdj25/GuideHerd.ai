'use strict';

const { SessionStatus } = require('./status');
const { HANDOFF_TTL_SECONDS } = require('./models');
const defaultIds = require('./ids');

/** Format epoch milliseconds as an ISO-8601 UTC string. */
function toIso(ms) {
  return new Date(ms).toISOString();
}

/** Derive a last name from a full name (best-effort; last whitespace token). */
function deriveLastName(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

/**
 * Handoff service: creates short-lived sessions and redeems single-use tokens.
 *
 * @param {{
 *   store: ReturnType<typeof import('./store').createInMemoryHandoffStore>,
 *   clock: import('./clock').Clock,
 *   ttlSeconds?: number,
 *   idgen?: typeof import('./ids'),
 * }} deps
 */
function createHandoffService({ store, clock, ttlSeconds = HANDOFF_TTL_SECONDS, idgen = defaultIds }) {
  return {
    /**
     * @param {import('./models').CreateHandoffRequest} request validated input
     * @returns {{ handoffToken: string, response: import('./models').CreateHandoffResponse }}
     */
    create(request) {
      const now = clock.now();
      const sessionId = idgen.generateSessionId();
      const token = idgen.generateHandoffToken();
      const tokenHash = idgen.hashToken(token);
      const expiresAtMs = now + ttlSeconds * 1000;

      /** @type {import('./models').InternalSession} */
      const session = {
        sessionId,
        firmId: request.firmId,
        caller: { ...request.caller },
        scheduling: { ...request.scheduling },
        handoff: { ...request.handoff },
        status: SessionStatus.AWAITING_TRANSFER,
        tokenHash,
        redeemedAtMs: null,
        createdAtMs: now,
        expiresAtMs,
      };
      store.create(session);

      // The raw token is returned exactly once here and never stored or logged.
      return {
        handoffToken: token,
        response: {
          sessionId,
          handoffToken: token,
          status: session.status,
          createdAt: toIso(now),
          expiresAt: toIso(expiresAtMs),
          expiresInSeconds: ttlSeconds,
        },
      };
    },

    /**
     * Redeem a token and return the minimum context for the Scheduling Assistant.
     * @param {string} token
     * @returns {import('./models').RedeemResponse}
     */
    redeem(token) {
      const tokenHash = idgen.hashToken(token);
      const session = store.redeem(tokenHash); // throws domain errors on failure

      return {
        sessionId: session.sessionId,
        callerName: session.caller.fullName,
        callerLastName: deriveLastName(session.caller.fullName),
        callerPhone: session.caller.phone ?? null,
        attorneyId: session.scheduling.attorneyId,
        practiceAreaId: session.scheduling.practiceAreaId ?? null,
        consultationTypeId: session.scheduling.consultationTypeId,
        existingClient: session.scheduling.existingClient ?? false,
        status: session.status,
      };
    },
  };
}

module.exports = { createHandoffService };
