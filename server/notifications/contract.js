'use strict';

/**
 * The GuideHerd Notification Contract (ADR-0011) — the permanent boundary
 * for customer notifications.
 *
 * GuideHerd — not a calendar provider, not a mail API, not any future
 * channel — owns customer notifications: when they are sent, why, what
 * they say, who receives them, and which provider delivers them. Core
 * expresses a NOTIFICATION REQUEST in GuideHerd domain language; a
 * Notification Provider translates the rendered, branded message into its
 * delivery dialect and delivers it. Providers never decide recipients,
 * timing, content, branding, or workflow (ADR-0007 §3).
 *
 * A NotificationRequest (strict allowlist — unknown keys are rejected so
 * provider payloads and stray PII can never ride along):
 *
 *   {
 *     type,             one of NOTIFICATION_TYPES
 *     organizationKey,  the firm this notification belongs to
 *     notificationKey,  GuideHerd idempotency key — one logical customer
 *                       notification per key, ever (e.g.
 *                       "appointment-confirmation:<sessionId>")
 *     recipient: { name?, email },
 *     appointment: { startsAt, timezone, attorneyName?,
 *                    consultationType?, location? },
 *     locale?           BCP-47 tag; defaults to en-US
 *   }
 *
 * A Notification Provider is a plain object (registry pattern shared with
 * Connect/Identity):
 *
 *   {
 *     providerKey: 'graph-email',
 *     // Deliver one rendered, branded message. Returns
 *     //   { status: 'sent'|'failed'|'not-configured', providerRequestId? }
 *     // NEVER throws to Core; provider dialect errors are classified into
 *     // the GuideHerd taxonomy at this boundary (Issue #8) and surface
 *     // only as telemetry + the neutral status.
 *     deliver({ rendered, recipient, branding }, context) -> Promise<result>
 *   }
 */

const NOTIFICATION_TYPES = Object.freeze([
  'appointment-confirmation',
  'appointment-cancellation',
  'appointment-rescheduled',
  'appointment-reminder',
]);

const REQUEST_KEYS = Object.freeze(['type', 'organizationKey', 'notificationKey', 'recipient', 'appointment', 'locale']);
const RECIPIENT_KEYS = Object.freeze(['name', 'email']);
const APPOINTMENT_KEYS = Object.freeze(['startsAt', 'timezone', 'attorneyName', 'consultationType', 'location']);

const LIMITS = Object.freeze({ key: 256, string: 254 });

function isNonblank(v, max = LIMITS.string) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

/**
 * Validate and canonicalize a NotificationRequest. Throws TypeError on any
 * violation — an invalid request is a programming error at the call site,
 * never a customer-facing condition.
 */
function validateNotificationRequest(request) {
  const fail = (reason) => { throw new TypeError(`Invalid NotificationRequest: ${reason}`); };
  if (request === null || typeof request !== 'object') fail('not an object');
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key)) fail(`unknown key ${key}`);
  }
  if (!NOTIFICATION_TYPES.includes(request.type)) fail('unknown type');
  if (!isNonblank(request.organizationKey, 128)) fail('organizationKey required');
  if (!isNonblank(request.notificationKey, LIMITS.key)) fail('notificationKey required');

  const recipient = request.recipient;
  if (recipient === null || typeof recipient !== 'object') fail('recipient required');
  for (const key of Object.keys(recipient)) {
    if (!RECIPIENT_KEYS.includes(key)) fail(`unknown recipient key ${key}`);
  }
  if (!isNonblank(recipient.email)) fail('recipient.email required');
  if (recipient.name !== undefined && !isNonblank(recipient.name, 200)) fail('recipient.name invalid');

  const appointment = request.appointment;
  if (appointment === null || typeof appointment !== 'object') fail('appointment required');
  for (const key of Object.keys(appointment)) {
    if (!APPOINTMENT_KEYS.includes(key)) fail(`unknown appointment key ${key}`);
  }
  if (!isNonblank(appointment.startsAt, 64) || Number.isNaN(Date.parse(appointment.startsAt))) fail('appointment.startsAt must be an ISO-8601 datetime');
  if (!isNonblank(appointment.timezone, 64)) fail('appointment.timezone required');
  for (const key of ['attorneyName', 'consultationType', 'location']) {
    if (appointment[key] !== undefined && !isNonblank(appointment[key], 200)) fail(`appointment.${key} invalid`);
  }
  if (request.locale !== undefined && !isNonblank(request.locale, 35)) fail('locale invalid');

  return {
    type: request.type,
    organizationKey: request.organizationKey.trim(),
    notificationKey: request.notificationKey.trim(),
    recipient: {
      name: recipient.name === undefined ? null : recipient.name.trim(),
      email: recipient.email.trim(),
    },
    appointment: {
      startsAt: appointment.startsAt.trim(),
      timezone: appointment.timezone.trim(),
      attorneyName: appointment.attorneyName === undefined ? null : appointment.attorneyName.trim(),
      consultationType: appointment.consultationType === undefined ? null : appointment.consultationType.trim(),
      location: appointment.location === undefined ? null : appointment.location.trim(),
    },
    locale: request.locale === undefined ? 'en-US' : request.locale.trim(),
  };
}

/**
 * Notification provider registry — resolution failures are explicit
 * misconfiguration, never a silent substitute (the Connect/Identity
 * registry pattern).
 */
function createNotificationProviderRegistry() {
  /** @type {Map<string, object>} */
  const providers = new Map();
  return {
    register(provider) {
      if (!provider || typeof provider.providerKey !== 'string' || provider.providerKey === ''
        || typeof provider.deliver !== 'function') {
        throw new TypeError('A notification provider must declare a nonblank providerKey and deliver().');
      }
      providers.set(provider.providerKey, provider);
      return provider;
    },
    resolve(providerKey) {
      const provider = providers.get(providerKey);
      if (!provider) {
        const err = new Error('The configured notification provider is not available.');
        err.code = 'notification_provider_unavailable';
        err.category = 'permanent_internal_failure';
        throw err;
      }
      return provider;
    },
    keys() {
      return [...providers.keys()];
    },
  };
}

module.exports = { NOTIFICATION_TYPES, validateNotificationRequest, createNotificationProviderRegistry };
