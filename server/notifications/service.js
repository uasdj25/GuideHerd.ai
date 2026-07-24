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
const { renderNotificationRequest } = require('./templates');
const { buildAppointmentIcs } = require('./ics');

const SETTINGS_NAMESPACE = 'notifications';
const PROVIDER_KEY_SETTING = 'provider';
const DEFAULT_NOTIFICATION_PROVIDER = 'graph-email';

/** Resolve the organization's notification provider key (config-driven). */
function resolveNotificationProviderKey(configService, organizationKey) {
  if (!configService || !organizationKey) return DEFAULT_NOTIFICATION_PROVIDER;
  const { readDomain } = require('../configuration/framework');
  return readDomain(configService, 'notification-provider', organizationKey).value.provider;
}

/**
 * @param {{
 *   registry: ReturnType<typeof import('./contract').createNotificationProviderRegistry>,
 *   deliveryStore: { claim: Function, record: Function },
 *   configService?: object|null,
 *   telemetry?: { event: Function },
 * }} deps
 */
function createNotificationService({ registry, deliveryStore, configService = null, telemetry, typeProviders = {} }) {
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
        // Per-type provider defaults (e.g. the firm-facing summary mailbox
        // boundary) win over the organization's configured provider —
        // interim until per-type provider selection becomes a
        // configuration domain (ADR-0016).
        providerKey = typeProviders[request.type]
          || resolveNotificationProviderKey(configService, request.organizationKey);
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
      const rendered = renderNotificationRequest(request, branding);

      // Appointment lifecycle notifications carry an ICS attachment so
      // the caller's own calendar tracks the appointment (#88):
      // confirmation/reschedule = METHOD:REQUEST (reschedule bumps
      // SEQUENCE), cancellation = METHOD:CANCEL. The UID is the
      // notification key's booking identity — stable across the
      // lifecycle, never caller data.
      let attachments;
      if (['appointment-confirmation', 'appointment-rescheduled', 'appointment-cancellation'].includes(request.type)) {
        const bookingIdentity = request.notificationKey.slice(request.notificationKey.indexOf(':') + 1);
        attachments = [buildAppointmentIcs({
          uid: `guideherd-${bookingIdentity}`,
          startsAt: request.appointment.startsAt,
          durationMinutes: request.appointment.durationMinutes ?? 30,
          summary: request.appointment.consultationType
            ? `${request.appointment.consultationType}${request.appointment.attorneyName ? ` with ${request.appointment.attorneyName}` : ''}`
            : 'Consultation',
          method: request.type === 'appointment-cancellation' ? 'CANCEL' : 'REQUEST',
          sequence: request.type === 'appointment-rescheduled' ? 1 : 0,
          nowMs: Date.now(),
        })];
      }
      const result = await provider.deliver(
        { rendered, recipient: request.recipient, branding, ...(attachments ? { attachments } : {}) },
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
