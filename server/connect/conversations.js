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
const { systemClock } = require('../handoff/clock');
const { SessionStatus } = require('../handoff/status');
const { createConversationEvents } = require('./events');

const TERMINAL = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];

/**
 * @param {{
 *   service: ReturnType<typeof import('../handoff/service').createHandoffService>,
 *   store: ReturnType<typeof import('../handoff/store').createInMemoryHandoffStore>,
 *   mailer: object,
 *   events?: ReturnType<typeof createConversationEvents>,
 *   clock?: import('../handoff/clock').Clock,
 * }} deps
 */
function createConversationService({ service, store, mailer, events = createConversationEvents(), clock = systemClock() }) {
  const atIso = () => new Date(clock.now()).toISOString();

  return {
    events,

    /**
     * Connect the provider's conversation to the prepared session for a firm
     * (exactly-one-eligible correlation; the handoff session's single-use
     * semantics are unchanged). Returns the prepared caller context in the
     * exact shape the integration receives today.
     *
     * @param {string} firmId
     * @param {string} provider adapter provider key, for event provenance
     */
    connect(firmId, provider) {
      const context = service.connectDemo(firmId); // throws 404/409/410 exactly as before
      events.emit('conversation.connected', {
        sessionId: context.sessionId,
        firmId,
        provider,
        at: atIso(),
      });
      return context;
    },

    /**
     * Record a terminal outcome for a conversation and deliver the
     * Consultation Summary exactly once (identical semantics to the
     * pre-Connect flow — the logic is shared, not duplicated).
     *
     * @param {string} sessionId
     * @param {object} outcome canonical validated outcome
     * @param {string} provider adapter provider key, for event provenance
     */
    async complete(sessionId, outcome, provider) {
      // An idempotent duplicate report (allowed by the outcome contract)
      // must not emit a second completion event.
      const before = store.get(sessionId);
      const alreadyTerminal = Boolean(before && TERMINAL.includes(before.status));

      const result = await recordOutcomeAndDeliver({ service, store, mailer }, sessionId, outcome);

      if (!alreadyTerminal) {
        const session = store.get(result.sessionId);
        events.emit('conversation.completed', {
          sessionId: result.sessionId,
          firmId: session ? session.firmId : null,
          provider,
          status: result.status,
          summaryDelivery: result.summaryDelivery,
          at: atIso(),
        });
      }
      return result;
    },
  };
}

module.exports = { createConversationService };
