'use strict';

/**
 * Notification triggers (ADR-0011) — where GuideHerd decides WHEN and WHY
 * a customer notification is sent.
 *
 * The first trigger: an appointment confirmation when a conversation
 * completes with a booked outcome. It attaches to the conversation-events
 * seam (ADR-0005 §5) — exactly the subscription point that seam was built
 * for — and looks the caller up through the repository (event payloads
 * never carry contact details).
 *
 * ── DISABLED BY DEFAULT, deliberately ─────────────────────────────────────
 * Today the assistant's calendar tool books appointments in the external
 * calendar provider, which sends its OWN attendee confirmation emails —
 * a channel GuideHerd has no integration with and cannot suppress from
 * this platform (see ADR-0011 §7). Sending ours too would DOUBLE-NOTIFY
 * the customer. The trigger therefore requires the per-organization
 * setting:
 *
 *   namespace: "notifications"  key: "appointment-confirmation"
 *   value:     { "enabled": true }
 *
 * and stays inert without it — current customer behavior is preserved
 * exactly. Flip the setting only after the calendar provider's attendee
 * emails are confirmed disabled for the firm.
 *
 * Cancellation, reschedule, and reminder types are fully supported by the
 * contract/templates/service; their triggers arrive with the workflows
 * that produce those moments (no booked-appointment cancellation flow,
 * reschedule flow, or scheduler exists in the platform today).
 */

const { getSchedulingOptions } = require('../config/options');

const SETTINGS_NAMESPACE = 'notifications';
const CONFIRMATION_KEY = 'appointment-confirmation';

/** Is the appointment-confirmation trigger explicitly enabled for the org? */
function confirmationEnabled(configService, organizationKey) {
  if (!configService) return false;
  try {
    const setting = configService.settings.get(organizationKey, SETTINGS_NAMESPACE, CONFIRMATION_KEY);
    return Boolean(setting && setting.value && setting.value.enabled === true);
  } catch {
    return false;
  }
}

/** Best-effort display names from the Configuration Store; never blocking. */
function displayNames(configService, organizationKey, scheduling) {
  const names = { attorneyName: undefined, consultationType: undefined };
  if (!configService) return names;
  try {
    const options = getSchedulingOptions(configService, organizationKey);
    if (scheduling.attorneyId) {
      for (const attorneys of Object.values(options.attorneysByPracticeArea || {})) {
        const match = (attorneys || []).find((a) => a.id === scheduling.attorneyId);
        if (match && match.name) { names.attorneyName = match.name; break; }
      }
    }
    if (scheduling.consultationTypeId) {
      const type = (options.consultationTypes || []).find((t) => t.id === scheduling.consultationTypeId);
      if (type && type.name) names.consultationType = type.name;
    }
  } catch { /* names are optional; the notification still renders */ }
  return names;
}

/**
 * Subscribe the booked-confirmation trigger to conversation events.
 * @param {{
 *   events: { on: Function },
 *   store: { get: Function },
 *   notificationService: { send: Function },
 *   configService?: object|null,
 *   telemetry?: { event: Function },
 * }} deps
 */
function registerNotificationTriggers({ events, store, notificationService, configService = null, telemetry }) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  async function onCompleted(payload) {
    if (!payload || payload.status !== 'booked') return;
    if (!confirmationEnabled(configService, payload.firmId)) return;

    const session = await store.get(payload.sessionId);
    if (!session || !session.caller || !session.caller.email) return;
    const appointment = session.outcome && session.outcome.appointment;
    if (!appointment) return;

    const names = displayNames(configService, payload.firmId, session.scheduling || {});
    await notificationService.send({
      type: 'appointment-confirmation',
      organizationKey: payload.firmId,
      // One confirmation per session, ever — retries, duplicate outcome
      // reports, and multi-instance replays all collapse onto this key.
      notificationKey: `appointment-confirmation:${payload.sessionId}`,
      recipient: { name: session.caller.fullName, email: session.caller.email },
      appointment: {
        startsAt: appointment.startsAt,
        timezone: appointment.timezone,
        attorneyName: names.attorneyName,
        consultationType: names.consultationType,
      },
    }, { correlationId: payload.correlationId ?? undefined, sessionId: payload.sessionId });
  }

  events.on('conversation.completed', (payload) => {
    // Fire-and-forget: a notification problem must never break the
    // conversation flow. Failures surface through telemetry only.
    onCompleted(payload).catch((err) => {
      emit('notification.delivery_failed', {
        severity: 'error',
        component: 'internal',
        operation: 'notification-trigger',
        category: 'unexpected_error',
        correlationId: payload && payload.correlationId ? payload.correlationId : undefined,
        sessionId: payload && payload.sessionId ? payload.sessionId : undefined,
        errorName: err && err.name ? String(err.name) : 'Error',
      });
    });
  });
}

module.exports = { registerNotificationTriggers, confirmationEnabled, SETTINGS_NAMESPACE, CONFIRMATION_KEY };
