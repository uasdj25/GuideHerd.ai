'use strict';

/**
 * GuideHerd Connect — the provider-neutral conversation service.
 *
 * Owns the conversation lifecycle ABOVE the telephony provider: prepared-
 * session correlation, connect/complete transitions, outcome recording,
 * Consultation Summary delivery, and conversation events. It deliberately
 * owns NO transport: audio, telephony, SIP/RTP, and media stay with the
 * external provider (today: a native Twilio number assigned to the
 * ElevenLabs Scheduling Assistant), which this service never touches.
 *
 * v1 keeps conversation state on the handoff session itself — the session
 * state machine (awaiting-transfer → connected → booked/failed/escalated,
 * plus cancelled/expired) IS the conversation lifecycle today, and
 * duplicating it would create two sources of truth. When the Operational
 * Store arrives, conversations gain their own persisted records behind this
 * same service without touching provider adapters or routes.
 *
 * Events emitted (see events.js for the payload rules):
 *   conversation.connected  { sessionId, firmId, provider, at }
 *   conversation.completed  { sessionId, firmId, provider, status,
 *                             summaryDelivery, at }
 */

const { recordOutcomeAndDeliver } = require('../handoff/demo-bridge');
const { presentCallerContext } = require('../handoff/service');
const { systemClock } = require('../handoff/clock');
const { SessionStatus } = require('../handoff/status');
const { createConversationEvents } = require('./events');
const { createCorrelationEngine } = require('./correlation');

const TERMINAL = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];

/**
 * @param {{
 *   service: ReturnType<typeof import('../handoff/service').createHandoffService>,
 *   store: ReturnType<typeof import('../handoff/store').createInMemoryHandoffStore>,
 *   mailer: object,
 *   events?: ReturnType<typeof createConversationEvents>,
 *   clock?: import('../handoff/clock').Clock,
 *   correlation?: ReturnType<typeof createCorrelationEngine>,
 * }} deps
 */
function createConversationService({
  service, store, mailer,
  events = createConversationEvents(),
  clock = systemClock(),
  correlation,
  telemetry,
}) {
  const atIso = () => new Date(clock.now()).toISOString();
  // The Correlation Engine (correlation.js) answers "find the matching
  // prepared session" — this service never knows how the match was made.
  const engine = correlation || createCorrelationEngine({ store });
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  return {
    events,

    /**
     * Connect the provider's conversation to the prepared session matching
     * the neutral ConnectIntent (the handoff session's single-use semantics
     * are unchanged). An empty intent preserves the original exactly-one-
     * eligible behavior byte for byte. Returns the prepared caller context
     * in the exact shape the integration receives today.
     *
     * @param {string} firmId
     * @param {string} provider adapter provider key, for event provenance
     * @param {object} [intent] neutral ConnectIntent from the adapter
     * @param {{ correlationId?: string }} [context] operation context (Issue #8)
     */
    async connect(firmId, provider, intent = {}, context = {}) {
      let result;
      try {
        // throws 404/409 exactly as before; ambiguity is never resolved by guessing
        result = await engine.correlate(firmId, intent);
      } catch (err) {
        emit('correlation.failed', {
          severity: 'warn',
          component: 'correlation-engine',
          operation: 'connect',
          category: err && err.code === 'ambiguous_prepared_sessions' ? 'conflict' : 'not_found',
          code: err && err.code ? err.code : undefined,
          correlationId: context.correlationId,
          organizationKey: firmId,
          provider,
        });
        throw err;
      }
      const { session, matchedBy } = result;
      events.emit('conversation.connected', {
        sessionId: session.sessionId,
        firmId,
        provider,
        correlation: matchedBy, // signal key only — never a signal VALUE
        correlationId: context.correlationId ?? null,
        at: atIso(),
      });
      return presentCallerContext(session);
    },

    /**
     * Record a terminal outcome for a conversation and deliver the
     * Consultation Summary exactly once (identical semantics to the
     * pre-Connect flow — the logic is shared, not duplicated).
     *
     * @param {string} sessionId
     * @param {object} outcome canonical validated outcome
     * @param {string} provider adapter provider key, for event provenance
     * @param {{ correlationId?: string }} [context] operation context (Issue #8)
     */
    async complete(sessionId, outcome, provider, context = {}) {
      // An idempotent duplicate report (allowed by the outcome contract)
      // must not emit a second completion event.
      const before = await store.get(sessionId);
      const alreadyTerminal = Boolean(before && TERMINAL.includes(before.status));

      let result;
      try {
        result = await recordOutcomeAndDeliver(
          { service, store, mailer, telemetry },
          sessionId,
          outcome,
          { correlationId: context.correlationId, organizationKey: before ? before.firmId : undefined },
        );
      } catch (err) {
        emit('outcome.failed', {
          severity: 'warn',
          component: 'handoff',
          operation: 'record-outcome',
          category: err && err.status === 409 ? 'conflict' : 'not_found',
          code: err && err.code ? err.code : undefined,
          correlationId: context.correlationId,
          organizationKey: before ? before.firmId : undefined,
          sessionId,
          provider,
        });
        throw err;
      }

      if (!alreadyTerminal) {
        const session = await store.get(result.sessionId);
        events.emit('conversation.completed', {
          sessionId: result.sessionId,
          firmId: session ? session.firmId : null,
          provider,
          status: result.status,
          summaryDelivery: result.summaryDelivery,
          correlationId: context.correlationId ?? null,
          at: atIso(),
        });
      }
      return result;
    },
  };
}

module.exports = { createConversationService };
