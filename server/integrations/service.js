'use strict';

/**
 * The GuideHerd Integration Service (ADR-0020) — Core's single entry point
 * for outbound system-to-system effects.
 *
 * Business code states an INTENT ("sync this consultation record"); this
 * service owns everything after that: validation, idempotency, provider
 * selection, delivery, and telemetry. Callers never compose provider
 * payloads, and providers never make business decisions. The shape is the
 * Notification Service's (ADR-0011), adapted for system-to-system
 * semantics — deliberately the same discipline, not a second pattern.
 *
 * Idempotency: exactly one logical system-to-system effect exists per
 * integrationKey, ever. The delivery store's claim is taken BEFORE any
 * provider call — a duplicate request (an at-least-once outbox redelivery,
 * a replayed workflow signal, a second API instance) fails to claim and is
 * suppressed without a provider call. A 'failed' delivery may be
 * re-claimed later; 'completed' is final forever.
 *
 * Provider selection is per-organization configuration
 * (`integrations/provider`, ADR-0016). The domain is DARK BY DEFAULT:
 * with no provider configured the request resolves to the controlled
 * 'not-configured' result — never an error, never a crash. An explicitly
 * configured but unregistered provider fails loudly (ADR-0007 §6) — the
 * failure is recorded re-claimable so recovery succeeds once the
 * deployment registers the provider.
 *
 * Trigger sources are the platform's canonical asynchronous pipeline:
 * durable outbox events (ADR-0017) and scheduled actions (ADR-0018) call
 * this entry point from their consumers/handlers, whose bounded retries
 * and stale-claim recovery this claim machine makes duplication-safe. The
 * future Workflow Contract states integration intents through this same
 * entry point.
 */

const { validateIntegrationRequest } = require('./contract');

const SETTINGS_NAMESPACE = 'integrations';
const PROVIDER_KEY_SETTING = 'provider';

/**
 * Resolve the organization's integration provider key (config-driven).
 * `null` means the organization has no integration provider — the dark
 * default.
 * @returns {string|null}
 */
function resolveIntegrationProviderKey(configService, organizationKey) {
  if (!configService || !organizationKey) return null;
  const { readDomain } = require('../configuration/framework');
  return readDomain(configService, 'integration-provider', organizationKey).value.provider;
}

/**
 * @param {{
 *   registry: ReturnType<typeof import('./contract').createIntegrationProviderRegistry>,
 *   deliveryStore: { claim: Function, record: Function },
 *   configService?: object|null,
 *   telemetry?: { event: Function },
 * }} deps
 */
function createIntegrationService({ registry, deliveryStore, configService = null, telemetry }) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  return {
    /**
     * Request one system-to-system effect, exactly once per integrationKey.
     *
     * @param {object} rawRequest an IntegrationRequest (validated here)
     * @param {{ correlationId?: string, sessionId?: string }} [context]
     * @returns {Promise<{ status: 'completed'|'failed'|'not-configured'|'suppressed',
     *                     suppressedBy?: string }>}
     *          Never throws for delivery problems; invalid REQUESTS throw
     *          TypeError (a call-site programming error).
     */
    async request(rawRequest, context = {}) {
      const request = validateIntegrationRequest(rawRequest);
      const eventFields = {
        component: 'internal',
        operation: 'integration',
        correlationId: context.correlationId,
        organizationKey: request.organizationKey,
        sessionId: context.sessionId,
        integrationType: request.type,
        integrationKey: request.integrationKey,
      };

      // Idempotency FIRST: no claim, no provider call, no duplicate effect.
      const claim = await deliveryStore.claim(request.integrationKey);
      if (!claim.claimed) {
        emit('integration.suppressed', {
          ...eventFields,
          severity: 'info',
          code: claim.status === 'completed' ? 'already_completed' : 'delivery_in_progress',
        });
        return { status: 'suppressed', suppressedBy: claim.status };
      }

      // Dark by default: an organization without a configured provider gets
      // the controlled result, recorded, with no provider call and no error.
      const providerKey = resolveIntegrationProviderKey(configService, request.organizationKey);
      if (providerKey === null) {
        await deliveryStore.record(request.integrationKey, 'not-configured');
        emit('integration.delivery_failed', {
          ...eventFields,
          severity: 'warn',
          code: 'provider_not_configured',
        });
        return { status: 'not-configured' };
      }

      let provider;
      try {
        provider = registry.resolve(providerKey); // loud on misconfiguration (ADR-0007 §6)
      } catch (err) {
        // Recorded 'failed' (re-claimable): once the deployment registers
        // the configured provider, recovery delivers without duplication.
        await deliveryStore.record(request.integrationKey, 'failed');
        emit('integration.delivery_failed', {
          ...eventFields,
          severity: 'error',
          category: 'permanent_internal_failure',
          code: err && err.code ? err.code : undefined,
          provider: providerKey,
        });
        return { status: 'failed' };
      }

      const result = await provider.deliver(
        { request },
        { ...context, organizationKey: request.organizationKey, integrationType: request.type, integrationKey: request.integrationKey },
      );
      const status = ['completed', 'failed', 'not-configured'].includes(result && result.status)
        ? result.status
        : 'failed'; // a provider returning nonsense fails closed
      await deliveryStore.record(request.integrationKey, status);

      if (status === 'completed') {
        emit('integration.delivered', {
          ...eventFields,
          severity: 'info',
          provider: providerKey,
          providerRequestId: result.providerRequestId,
        });
      } else {
        emit('integration.delivery_failed', {
          ...eventFields,
          severity: status === 'not-configured' ? 'warn' : 'error',
          provider: providerKey,
          code: status === 'not-configured' ? 'provider_not_configured' : undefined,
        });
      }
      return { status };
    },
  };
}

module.exports = {
  createIntegrationService,
  resolveIntegrationProviderKey,
  SETTINGS_NAMESPACE,
  PROVIDER_KEY_SETTING,
};
