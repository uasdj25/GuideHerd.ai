'use strict';

/**
 * Conversation events — the extensibility seam of GuideHerd Connect.
 *
 * A deliberately tiny synchronous pub/sub: subscribers are optional, and in
 * v1 nothing subscribes in production. The point is that conversation
 * lifecycle transitions are now OBSERVABLE at a provider-neutral boundary,
 * so future capabilities (operational store persistence, live console
 * updates, analytics, follow-up workflows) attach here instead of inside
 * provider-facing routes.
 *
 * Event payload rule: payloads identify a conversation (sessionId, firmId,
 * provider) and describe the transition. They NEVER contain credentials,
 * tokens, provider payloads, or caller contact details — subscribers that
 * need caller context must look it up through an authorized path.
 *
 * Emission is fire-and-forget: a throwing subscriber never breaks the
 * conversation flow (the failure is contained and logged).
 */
function createConversationEvents() {
  /** @type {Map<string, Array<(payload: object) => void>>} */
  const subscribers = new Map();

  return {
    /**
     * Subscribe to an event type. Returns an unsubscribe function.
     * @param {string} type e.g. 'conversation.connected'
     * @param {(payload: object) => void} fn
     */
    on(type, fn) {
      if (!subscribers.has(type)) subscribers.set(type, []);
      subscribers.get(type).push(fn);
      return () => {
        const list = subscribers.get(type) || [];
        const index = list.indexOf(fn);
        if (index !== -1) list.splice(index, 1);
      };
    },

    /**
     * Emit an event to all subscribers of its type.
     * @param {string} type
     * @param {object} payload
     */
    emit(type, payload) {
      for (const fn of subscribers.get(type) || []) {
        try {
          fn(payload);
        } catch (err) {
          // A misbehaving subscriber must never break the conversation.
          console.log(JSON.stringify({
            level: 'error',
            message: 'Conversation event subscriber failed.',
            event: type,
            error: String(err && err.message),
          }));
        }
      }
    },
  };
}

module.exports = { createConversationEvents };
