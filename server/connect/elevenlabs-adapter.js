'use strict';

/**
 * ElevenLabs Conversation Adapter.
 *
 * Wraps today's working integration EXACTLY as it behaves — the native
 * Twilio → ElevenLabs call path stays untouched, and this adapter changes
 * no functionality. It exists to give that behavior a provider-neutral
 * boundary: everything ElevenLabs-dialect-specific about how the Scheduling
 * Assistant talks to GuideHerd is named and contained here.
 *
 * ElevenLabs dialect specifics (verified against the live integration):
 *
 *  1. Connect requests carry a meaningless body. The ElevenLabs webhook
 *     tool UI requires at least one JSON property on POST tools, so the
 *     `get_prepared_caller` server tool sends a fixed body such as
 *     {"request": "connect"}. GuideHerd ignores it entirely.
 *
 *  2. Outcome reports arrive FLAT. The ElevenLabs webhook editor cannot
 *     practically construct nested objects, so `report_scheduling_outcome`
 *     sends { sessionId, status, appointment, reason } at the top level,
 *     with `reason` aliasing `schedulingSummary`. The canonical nested
 *     format is accepted too. Both shapes pass through the exact same
 *     canonical validation (strict allowlists, ISO-8601 + IANA rules) —
 *     nothing about the dialect is looser.
 *
 * The lift/validate logic currently lives in demo-bridge.normalizeOutcome
 * (temporary demo infrastructure). The adapter delegates to it so there is
 * ONE validation path while the demo bridge exists; when the bridge is
 * removed, that logic graduates here without any contract change.
 */

const { normalizeOutcome } = require('../handoff/demo-bridge');

function createElevenLabsAdapter() {
  return {
    providerKey: 'elevenlabs',

    /**
     * The connect body is provider ceremony (see dialect note 1) — the
     * neutral intent is empty: "connect the prepared caller for this firm".
     * @param {unknown} _rawBody parsed request body, if any
     */
    translateConnect(_rawBody) {
      return {};
    },

    /**
     * Lift the ElevenLabs flat outcome dialect (or accept the canonical
     * nested format) into GuideHerd's outcome contract. Validation is the
     * shared canonical path — identical for every provider.
     * @param {unknown} rawBody
     * @returns {{ sessionId: string, outcome: object }}
     */
    translateOutcome(rawBody) {
      return normalizeOutcome(rawBody);
    },
  };
}

module.exports = { createElevenLabsAdapter };
