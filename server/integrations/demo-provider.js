'use strict';

/**
 * The demonstration Integration Provider (ADR-0020) — the synthetic
 * provider that proves the extension seam end to end: registration,
 * configuration-selected resolution, delivery, duplication-safe retry
 * classification, and telemetry. It is deliberately NOT a real system:
 *
 *   - no network calls, ever
 *   - no credentials, ever
 *   - ships dark: registered on every deployment, selected by no
 *     organization until configuration names it
 *
 * Retry discipline mirrors the Graph mailer (ADR-0011): the provider
 * classifies each failure as retryable ONLY when the effect provably was
 * not accepted, and bounded retries run inside the provider boundary via
 * the shared withRetry helper. Core never sees provider dialect — only
 * the neutral result status.
 *
 * Test seams (everything injected, nothing global):
 *   behavior()  -> per-delivery script: 'complete' (default) |
 *                  'retryable-then-complete' | 'retryable-always' |
 *                  'nonretryable' | 'nonsense'
 *   deliveries  -> record of accepted effects (keys + fact NAMES only —
 *                  the demo provider is test infrastructure and still
 *                  refuses to retain fact values)
 */

const { withRetry } = require('../telemetry/retry');

const PROVIDER_KEY = 'demo-integration';

/**
 * @param {{
 *   behavior?: () => string,
 *   telemetry?: { event: Function },
 *   sleep?: (ms: number) => Promise<void>,
 *   retryAttempts?: number,
 * }} [deps]
 */
function createDemoIntegrationProvider({
  behavior = () => 'complete',
  telemetry,
  sleep = async () => {},
  retryAttempts = 3,
} = {}) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  /** @type {Array<{ integrationKey: string, type: string, factKeys: string[], attempts: number }>} */
  const accepted = [];

  return {
    providerKey: PROVIDER_KEY,

    /** Accepted effects, for tests and demonstrations. Never fact values. */
    deliveries() {
      return accepted.map((d) => ({ ...d, factKeys: [...d.factKeys] }));
    },

    /**
     * Deliver one integration effect. Never throws to Core.
     * @returns {Promise<{ status: 'completed'|'failed'|'not-configured', providerRequestId?: string }>}
     */
    async deliver({ request }, context = {}) {
      const script = behavior();
      if (script === 'nonsense') return { status: 'definitely-not-a-status' };

      let attempts = 0;
      try {
        await withRetry(async () => {
          attempts += 1;
          if (script === 'retryable-always'
            || (script === 'retryable-then-complete' && attempts < retryAttempts)) {
            const err = new Error('synthetic transient refusal (effect provably not accepted)');
            err.category = 'transient_provider_failure';
            err.retryable = true; // duplication-safe: the effect was refused outright
            throw err;
          }
          if (script === 'nonretryable') {
            const err = new Error('synthetic permanent refusal');
            err.category = 'permanent_provider_failure';
            err.retryable = false; // acceptance ambiguous or permanent: never blind-retry
            throw err;
          }
          // 'complete' (and the final retryable-then-complete attempt).
        }, {
          attempts: retryAttempts,
          backoffMs: [0, 0],
          sleep,
          onEvent: (name, fields) => emit(name, fields),
          fields: {
            component: 'internal',
            operation: 'integration-delivery',
            provider: PROVIDER_KEY,
            correlationId: context.correlationId,
            integrationKey: request.integrationKey,
          },
        });
      } catch {
        return { status: 'failed' };
      }

      accepted.push({
        integrationKey: request.integrationKey,
        type: request.type,
        factKeys: Object.keys(request.facts),
        attempts,
      });
      return { status: 'completed', providerRequestId: `demo-${accepted.length}` };
    },
  };
}

module.exports = { createDemoIntegrationProvider, PROVIDER_KEY };
