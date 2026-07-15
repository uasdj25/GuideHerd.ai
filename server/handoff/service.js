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
     * @returns {{ handoffToken: string, consoleToken: string, response: import('./models').CreateHandoffResponse }}
     */
    create(request) {
      const now = clock.now();
      const sessionId = idgen.generateSessionId();
      const token = idgen.generateHandoffToken();
      const consoleToken = idgen.generateConsoleToken();
      const expiresAtMs = now + ttlSeconds * 1000;

      /** @type {import('./models').InternalSession} */
      const session = {
        sessionId,
        firmId: request.firmId,
        caller: { ...request.caller },
        scheduling: { ...request.scheduling },
        handoff: { ...request.handoff },
        status: SessionStatus.AWAITING_TRANSFER,
        tokenHash: idgen.hashToken(token),
        consoleTokenHash: idgen.hashToken(consoleToken),
        redeemedAtMs: null,
        cancelledAtMs: null,
        completedAtMs: null,
        outcome: null,
        summaryDelivery: null, // null | 'pending' | 'sent' | 'failed' | 'not-configured'
        createdAtMs: now,
        expiresAtMs,
      };
      store.create(session);

      // Raw tokens are returned exactly once here and never stored or logged.
      // The handoff token is intended for the scheduling/voice side; a future
      // telephony integration will receive it through a trusted GuideHerd
      // handoff mechanism rather than through the browser. The console token
      // authorizes only status checks and cancellation.
      return {
        handoffToken: token,
        consoleToken,
        response: {
          sessionId,
          handoffToken: token,
          consoleToken,
          status: session.status,
          createdAt: toIso(now),
          expiresAt: toIso(expiresAtMs),
          expiresInSeconds: ttlSeconds,
        },
      };
    },

    /**
     * Operational status for the console. Requires the console token.
     * Never returns caller context.
     * @param {string} sessionId
     * @param {string} consoleToken
     * @returns {import('./models').SessionStatusResponse}
     */
    status(sessionId, consoleToken) {
      const session = store.statusByConsole(sessionId, idgen.hashToken(consoleToken));
      const body = {
        sessionId: session.sessionId,
        status: session.status,
        createdAt: toIso(session.createdAtMs),
        expiresAt: toIso(session.expiresAtMs),
      };
      // Operational scheduling metadata only — never caller context.
      // TODO(post-demo): appointment details likely belong on the future
      // Operational Store / Consultation Summary API rather than living on a
      // status endpoint long-term. Kept here for the demo so the Console can
      // truthfully display the booked time.
      if (session.status === SessionStatus.BOOKED && session.outcome && session.outcome.appointment) {
        body.appointment = { ...session.outcome.appointment };
      }
      return body;
    },

    /**
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * Server-held connect for the controlled demonstration: redeems the
     * single eligible prepared session for the firm and returns the caller
     * and scheduling context. Raw tokens and hashes never appear here.
     * @param {string} firmId
     */
    connectDemo(firmId) {
      const session = store.connectDemo(firmId);
      return {
        sessionId: session.sessionId,
        status: session.status,
        caller: {
          fullName: session.caller.fullName,
          email: session.caller.email,
          phone: session.caller.phone ?? null,
        },
        scheduling: {
          attorneyId: session.scheduling.attorneyId ?? null,
          practiceAreaId: session.scheduling.practiceAreaId ?? null,
          consultationTypeId: session.scheduling.consultationTypeId,
        },
        firmId: session.firmId,
      };
    },

    /**
     * TEMPORARY DEMO INFRASTRUCTURE (Slice 3).
     * Record a validated terminal outcome. Returns the session and whether
     * this call was an idempotent duplicate.
     * @param {string} sessionId
     * @param {object} outcome validated GuideHerd outcome
     */
    applyOutcome(sessionId, outcome) {
      return store.applyOutcome(sessionId, outcome);
    },

    /**
     * Cancel an awaiting-transfer session. Requires the console token.
     * Idempotent for already-cancelled sessions. Never returns caller context.
     * @param {string} sessionId
     * @param {string} consoleToken
     * @returns {{ sessionId: string, status: string }}
     */
    cancel(sessionId, consoleToken) {
      const session = store.cancel(sessionId, idgen.hashToken(consoleToken));
      return { sessionId: session.sessionId, status: session.status };
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
        callerEmail: session.caller.email,
        callerPhone: session.caller.phone ?? null,
        attorneyId: session.scheduling.attorneyId ?? null,
        practiceAreaId: session.scheduling.practiceAreaId ?? null,
        consultationTypeId: session.scheduling.consultationTypeId,
        status: session.status,
      };
    },
  };
}

module.exports = { createHandoffService };
