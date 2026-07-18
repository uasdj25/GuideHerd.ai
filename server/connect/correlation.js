'use strict';

/**
 * The Correlation Engine — "find the matching prepared session."
 *
 * GuideHerd Connect owns prepared-session correlation (ADR-0005); this module
 * is the permanent engine for it. Core asks one question — connect the
 * caller who just arrived to the prepared session they belong to — and never
 * knows HOW the match was made. Providers never see correlation logic;
 * adapters translate their dialect into a neutral ConnectIntent, and the
 * engine works only with that.
 *
 * A ConnectIntent is a plain object of OPTIONAL, provider-neutral fields
 * (see adapter.js for the adapter-side contract):
 *
 *   {
 *     sessionId,               // explicit GuideHerd session id
 *     callerPhone,             // caller ID / ANI as the provider reported it
 *     providerConversationId,  // provider's own conversation reference —
 *                              // correlated for provenance, never a key
 *   }
 *
 * ── Signals ────────────────────────────────────────────────────────────────
 *
 * Correlation evaluates an ordered list of SIGNALS. A signal is a plain
 * object:
 *
 *   {
 *     key,                  // stable name, for events/observability only
 *     authoritative,        // true: a present-but-unmatched signal FAILS the
 *                           // correlation instead of falling through — used
 *                           // when the signal names one exact session
 *     extract(intent),      // the signal's value from the intent, or null
 *                           // when the intent does not carry it (an
 *                           // unnormalizable value is also null: a signal
 *                           // never guesses)
 *     criteria(value),      // repository candidate criteria for the value —
 *                           // always tenant-scoped by the repository itself
 *   }
 *
 * The engine walks the signals in priority order:
 *
 *   1. A signal absent from the intent is skipped.
 *   2. A present signal narrows the eligible (awaiting-transfer, unexpired,
 *      same-organization) sessions via one ATOMIC repository call:
 *        - exactly one candidate  -> connected; done.
 *        - more than one          -> ambiguous (409). NEVER pick one.
 *        - zero                   -> authoritative signal: fail (404);
 *                                    otherwise: the signal could not narrow
 *                                    (e.g. no phone was recorded at prepare
 *                                    time) — continue to the next signal.
 *   3. With no signal deciding, the BASELINE applies: all eligible sessions
 *      for the organization — exactly-one connects, several is ambiguous,
 *      none is 404. This is precisely the pre-correlation behavior, so an
 *      intent with no signals regresses nothing.
 *
 * Tenant isolation is structural: every repository criteria is scoped to the
 * organization by the repository contract itself, so no signal — present or
 * future — can match across organizations.
 *
 * ── Extending with future signals ──────────────────────────────────────────
 *
 * Receptionist workstation, queue id, extension, Teams identity, SIP
 * headers, authenticated customer identity: each arrives as a new signal
 * object placed at its priority in the list (plus, where needed, an
 * additive Operational Store column + criteria key). Existing signals and
 * this engine do not change — the walk above is signal-agnostic.
 */

const { normalizePhone } = require('../handoff/phone');
const { NoPreparedSessionError } = require('../handoff/errors');

/** Priority 1 — an explicit GuideHerd session id names exactly one session. */
function sessionIdSignal() {
  return {
    key: 'session-id',
    authoritative: true,
    extract(intent) {
      const value = intent && typeof intent.sessionId === 'string' ? intent.sessionId.trim() : '';
      return value === '' ? null : value;
    },
    criteria(value) {
      return { sessionId: value };
    },
  };
}

/**
 * Priority 2/3 — caller phone from provider metadata (caller ID / ANI),
 * normalized to E.164 and matched only within the organization. A number
 * that cannot be normalized contributes no signal — never a guess.
 */
function callerPhoneSignal() {
  return {
    key: 'caller-phone',
    authoritative: false,
    extract(intent) {
      const raw = intent && typeof intent.callerPhone === 'string' ? intent.callerPhone : null;
      return raw === null ? null : normalizePhone(raw);
    },
    criteria(value) {
      return { callerPhoneNormalized: value };
    },
  };
}

/** The platform's default signal set, in priority order. */
function defaultSignals() {
  return [sessionIdSignal(), callerPhoneSignal()];
}

/** The result key used when no signal decided and the baseline matched. */
const BASELINE = 'exactly-one-eligible';

/**
 * @param {{
 *   store: { connectEligible(organizationKey: string, criteria: object): Promise<object> },
 *   signals?: Array<object>,
 * }} deps
 */
function createCorrelationEngine({ store, signals = defaultSignals() }) {
  for (const signal of signals) {
    if (!signal || typeof signal.key !== 'string' || signal.key === ''
      || typeof signal.extract !== 'function' || typeof signal.criteria !== 'function') {
      throw new TypeError('A correlation signal must declare key, extract(intent), and criteria(value).');
    }
  }

  return {
    /** Signal keys in priority order (observability/tests). */
    signalKeys() {
      return signals.map((s) => s.key);
    },

    /**
     * Find and atomically connect the prepared session matching the intent.
     *
     * @param {string} organizationKey
     * @param {object} [intent] neutral ConnectIntent (may be empty)
     * @returns {Promise<{ session: object, matchedBy: string }>}
     * @throws NoPreparedSessionError (404) when nothing matches;
     *         AmbiguousSessionError (409) when more than one candidate
     *         remains — the engine never picks one arbitrarily.
     */
    async correlate(organizationKey, intent = {}) {
      for (const signal of signals) {
        const value = signal.extract(intent);
        if (value === null || value === undefined) continue;
        try {
          const session = await store.connectEligible(organizationKey, signal.criteria(value));
          return { session, matchedBy: signal.key };
        } catch (err) {
          // Ambiguity always surfaces — never guess. A zero-candidate result
          // fails outright for an authoritative signal; a weaker signal that
          // failed to narrow defers to the next signal / the baseline.
          if (err instanceof NoPreparedSessionError && !signal.authoritative) continue;
          throw err;
        }
      }
      const session = await store.connectEligible(organizationKey, {});
      return { session, matchedBy: BASELINE };
    },
  };
}

module.exports = {
  createCorrelationEngine,
  defaultSignals,
  sessionIdSignal,
  callerPhoneSignal,
  BASELINE,
};
