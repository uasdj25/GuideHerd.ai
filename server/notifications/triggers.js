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
  const { readDomain } = require('../configuration/framework');
  return readDomain(configService, 'notifications', organizationKey).value.enabled === true;
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
 * Register the booked-confirmation trigger as a DURABLE OUTBOX CONSUMER
 * (ADR-0017). The trigger consumes the `conversation.completed` domain
 * event the repository published in the same transaction as the outcome —
 * so a crash between outcome and notification no longer loses the
 * confirmation (the old in-process at-most-once gap): the event survives,
 * and delivery retries at least once. Exactly-once customer effect is
 * preserved by the notification delivery-claim key, which makes this
 * consumer idempotent under at-least-once delivery.
 *
 * Behavior is otherwise identical to the in-process trigger it replaces:
 * booked outcomes only, per-organization enablement gate (disabled at
 * processing time settles the event without sending — enabling later
 * never resends history), caller looked up through the repository.
 *
 * @param {{
 *   outbox: { register: Function },
 *   store: { get: Function },
 *   notificationService: { send: Function },
 *   configService?: object|null,
 * }} deps
 */
function registerNotificationTriggers({ outbox, store, notificationService, configService = null }) {
  outbox.register({
    consumer: 'notifications',
    eventTypes: ['conversation.completed'],
    async handle(event) {
      if (!event.payload || event.payload.status !== 'booked') return;
      if (!confirmationEnabled(configService, event.organizationKey)) return;

      const session = await store.get(event.sessionId);
      if (!session || !session.caller || !session.caller.email) return;
      const appointment = session.outcome && session.outcome.appointment;
      if (!appointment) return;

      const names = displayNames(configService, event.organizationKey, session.scheduling || {});
      // notificationService.send never throws for delivery problems: its
      // own claim state machine owns notification retries. A throw here
      // (unexpected error) triggers OUTBOX retry — safe, because the
      // notificationKey makes the send idempotent.
      await notificationService.send({
        type: 'appointment-confirmation',
        organizationKey: event.organizationKey,
        // One confirmation per session, ever — outbox redelivery, duplicate
        // outcome reports, and multi-instance replays all collapse here.
        notificationKey: `appointment-confirmation:${event.sessionId}`,
        recipient: { name: session.caller.fullName, email: session.caller.email },
        appointment: {
          startsAt: appointment.startsAt,
          timezone: appointment.timezone,
          attorneyName: names.attorneyName,
          consultationType: names.consultationType,
        },
      }, { correlationId: event.correlationId ?? undefined, sessionId: event.sessionId });
    },
  });
}

module.exports = { registerNotificationTriggers, confirmationEnabled, displayNames, SETTINGS_NAMESPACE, CONFIRMATION_KEY };
