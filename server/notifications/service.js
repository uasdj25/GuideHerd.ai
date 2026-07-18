'use strict';

/**
 * The GuideHerd Notification Service (ADR-0011) — Core's single entry
 * point for customer notifications.
 *
 * Core states an INTENT ("send this firm's appointment confirmation to
 * this caller"); this service owns everything after that: validation,
 * idempotency, provider selection, branding, rendering, delivery, and
 * telemetry. Core never composes provider payloads, and providers never
 * make decisions.
 *
 * Idempotency: exactly one logical customer notification exists per
 * notificationKey, ever. The delivery store's claim is taken BEFORE any
 * provider call — a duplicate request (retry, replayed workflow, second
 * API instance) fails to claim and is suppressed without a provider call.
 * A 'failed' delivery may be re-claimed later; 'sent' is final forever.
 *
 * Provider selection is configuration: the `notifications/provider`
 * setting names the organization's provider, defaulting to graph-email.
 * An explicitly configured but unregistered provider fails loudly —
 * never a silent substitute (ADR-0007 §6).
 */

const { validateNotificationRequest } = require('./contract');
const { resolveBranding } = require('./branding');
const { buildTemplateModel, renderNotification } = require('./templates');

const SETTINGS_NAMESPACE = 'notifications';
const PROVIDER_KEY_SETTING = 'provider';
const DEFAULT_NOTIFICATION_PROVIDER = 'graph-email';

/** Resolve the organization's notification provider key (config-driven). */
function resolveNotificationProviderKey(configService, organizationKey) {
  if (!configService || !organizationKey) return DEFAULT_NOTIFICATION_PROVIDER;
  let setting;
  try {
    setting = configService.settings.get(organizationKey, SETTINGS_NAMESPACE, PROVIDER_KEY_SETTING);
  } catch {
    return DEFAULT_NOTIFICATION_PROVIDER;
  }
  const value = setting && setting.value;
  if (value && typeof value === 'object' && typeof value.provider === 'string' && value.provider.trim() !== '') {
    return value.provider.trim();
  }
  return DEFAULT_NOTIFICATION_PROVIDER;
}

/**
 * @param {{
 *   registry: ReturnType<typeof import('./contract').createNotificationProviderRegistry>,
 *   deliveryStore: { claim: Function, record: Function },
 *   configService?: object|null,
 *   telemetry?: { event: Function },
 * }} deps
 */
function createNotificationService({ registry, deliveryStore, configService = null, telemetry }) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  return {
    /**
     * Send one customer notification, exactly once per notificationKey.
     *
     * @param {object} rawRequest a NotificationRequest (validated here)
     * @param {{ correlationId?: string, sessionId?: string }} [context]
     * @returns {Promise<{ status: 'sent'|'failed'|'not-configured'|'suppressed',
     *                     suppressedBy?: string }>}
     *          Never throws for delivery problems; invalid REQUESTS throw
     *          TypeError (a call-site programming error).
     */
    async send(rawRequest, context = {}) {
      const request = validateNotificationRequest(rawRequest);
      const eventFields = {
        component: 'internal',
        operation: 'notification',
        correlationId: context.correlationId,
        organizationKey: request.organizationKey,
        sessionId: context.sessionId,
        notificationType: request.type,
        notificationKey: request.notificationKey,
      };

      // Idempotency FIRST: no claim, no provider call, no duplicate.
      const claim = await deliveryStore.claim(request.notificationKey);
      if (!claim.claimed) {
        emit('notification.suppressed', {
          ...eventFields,
          severity: 'info',
          code: claim.status === 'sent' ? 'already_sent' : 'delivery_in_progress',
        });
        return { status: 'suppressed', suppressedBy: claim.status };
      }

      let providerKey;
      let provider;
      try {
        providerKey = resolveNotificationProviderKey(configService, request.organizationKey);
        provider = registry.resolve(providerKey); // loud on misconfiguration
      } catch (err) {
        await deliveryStore.record(request.notificationKey, 'failed');
        emit('notification.delivery_failed', {
          ...eventFields,
          severity: 'error',
          category: 'permanent_internal_failure',
          code: err && err.code ? err.code : undefined,
        });
        return { status: 'failed' };
      }

      // GuideHerd owns branding and content; the provider only delivers.
      const branding = resolveBranding(configService, request.organizationKey);
      const rendered = renderNotification(buildTemplateModel(request, branding));

      const result = await provider.deliver(
        { rendered, recipient: request.recipient, branding },
        { ...context, organizationKey: request.organizationKey, notificationType: request.type, notificationKey: request.notificationKey },
      );
      const status = ['sent', 'failed', 'not-configured'].includes(result && result.status)
        ? result.status
        : 'failed'; // a provider returning nonsense fails closed
      await deliveryStore.record(request.notificationKey, status);

      if (status === 'sent') {
        emit('notification.delivered', {
          ...eventFields,
          severity: 'info',
          provider: providerKey,
          providerRequestId: result.providerRequestId,
        });
      } else {
        emit('notification.delivery_failed', {
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
  createNotificationService,
  resolveNotificationProviderKey,
  DEFAULT_NOTIFICATION_PROVIDER,
  SETTINGS_NAMESPACE,
  PROVIDER_KEY_SETTING,
};
