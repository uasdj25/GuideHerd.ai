'use strict';

const { ProviderUnavailableError } = require('./errors');

/**
 * GuideHerd Connect — the Conversation Adapter contract.
 *
 * GuideHerd owns conversation state (prepared caller context, lifecycle,
 * outcomes, summaries, configuration). External providers own the call
 * itself (audio, telephony, media transport). A Conversation Adapter is the
 * translation layer between one provider's dialect and GuideHerd's
 * provider-neutral contracts. Adapters NEVER transport audio, proxy media,
 * or speak SIP/RTP — they translate requests and shape responses, nothing
 * more.
 *
 * An adapter is a plain object with this shape:
 *
 *   {
 *     // Stable provider key. Matches the `provider` value in the
 *     // Configuration Store setting connect/conversation-provider.
 *     providerKey: 'elevenlabs',
 *
 *     // Translate the provider's "give me the prepared caller" request
 *     // into a neutral ConnectIntent. Receives the raw parsed request
 *     // body (which may be undefined). Every field is OPTIONAL; an empty
 *     // intent means "no correlation signals" and preserves the
 *     // exactly-one-prepared-session behavior:
 *     //
 *     //   {
 *     //     sessionId,               // explicit GuideHerd session id, when
 *     //                              // the provider can carry one through
 *     //     callerPhone,             // caller ID / ANI as reported; the
 *     //                              // Correlation Engine normalizes it —
 *     //                              // adapters never normalize
 *     //     providerConversationId,  // the provider's own conversation
 *     //                              // reference (provenance only — never
 *     //                              // a key of a GuideHerd object)
 *     //   }
 *     //
 *     // How the prepared session is FOUND from these signals belongs to
 *     // the Correlation Engine (correlation.js) — never to an adapter.
 *     // Throws a HandoffError/ConnectError subclass for invalid requests.
 *     translateConnect(rawBody) -> ConnectIntent
 *
 *     // Translate the provider's outcome report into GuideHerd's
 *     // canonical outcome contract. Provider-dialect tolerances (flat
 *     // formats, field aliases) live HERE; the canonical validation is
 *     // shared and identical for every provider.
 *     translateOutcome(rawBody) -> { sessionId, outcome }
 *   }
 *
 * Future providers (Teams, RingCentral, Cisco, Telnyx, direct SIP trunks,
 * Zoom Phone, ...) implement the same shape: however the phone call reaches
 * the assistant, the assistant-side runtime asks GuideHerd for prepared
 * context and reports an outcome, and the adapter translates those two
 * exchanges. Providers whose runtimes push richer signals (call started,
 * transferred, ended) will translate them into conversation events — the
 * contract grows by adding optional methods, never by leaking provider
 * payloads past the adapter.
 */

/**
 * Adapter registry: resolves a provider key to its registered adapter.
 * Resolution failures are an explicit misconfiguration (503) — GuideHerd
 * never silently substitutes a different provider.
 */
function createAdapterRegistry() {
  /** @type {Map<string, object>} */
  const adapters = new Map();

  return {
    /** @param {{ providerKey: string }} adapter */
    register(adapter) {
      if (!adapter || typeof adapter.providerKey !== 'string' || adapter.providerKey === '') {
        throw new TypeError('An adapter must declare a nonblank providerKey.');
      }
      adapters.set(adapter.providerKey, adapter);
      return adapter;
    },

    /**
     * @param {string} providerKey
     * @returns {object} the registered adapter
     * @throws {ProviderUnavailableError} when no adapter is registered
     */
    resolve(providerKey) {
      const adapter = adapters.get(providerKey);
      if (!adapter) throw new ProviderUnavailableError();
      return adapter;
    },

    keys() {
      return [...adapters.keys()];
    },
  };
}

module.exports = { createAdapterRegistry };
