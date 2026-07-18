'use strict';

/**
 * Appointment reminders — the first scheduled GuideHerd workflow
 * (ADR-0018). This module is a PRODUCER and a HANDLER on existing
 * contracts; it contains no infrastructure of its own:
 *
 *   conversation.completed (booked)          [Durable Event Outbox]
 *     └─ outbox consumer 'appointment-reminders'
 *          └─ scheduler.schedule() one action per configured slot
 *               └─ scheduler executes the action when runAt arrives
 *                    └─ notificationService.send(appointment-reminder)
 *                         └─ Notification Contract renders/brands/delivers
 *
 * ── DISABLED BY DEFAULT, deliberately ─────────────────────────────────────
 * Reminder scheduling requires the per-organization configuration domain
 * `appointment-reminders` ({ enabled: true, offsets: [...] }). Without
 * it the consumer settles booked events without scheduling anything —
 * today's production behavior is preserved exactly. Enabling later never
 * schedules reminders for historical bookings (the gate applies at
 * event-processing time), and the execution-time re-check means
 * DISABLING later stops reminders that are already scheduled.
 *
 * ── Time semantics ─────────────────────────────────────────────────────────
 * runAt is computed in UTC from the appointment's absolute instant
 * (`startsAt` carries an explicit offset by the outcome contract) minus
 * the configured offset. Organization timezone remains a presentation
 * concern: the reminder TEMPLATE formats times in the appointment's
 * timezone (ADR-0011); the scheduler never does timezone math.
 * A slot already in the past at booking time is skipped (no backdated
 * reminders); every action expires at the appointment start (a reminder
 * after the appointment must never send).
 *
 * ── Exactly-once ───────────────────────────────────────────────────────────
 * Duplicate reminders are STRUCTURALLY impossible, twice over: the
 * action key `appointment-reminder:<sessionId>:<slot>` dedupes
 * scheduling (outbox redelivery, duplicate outcome reports, concurrent
 * instances), and the notification key with the SAME shape makes the
 * customer effect exactly-once even under at-least-once action
 * execution (ADR-0011 claim, 'sent' final).
 */

const { readDomain } = require('../configuration/framework');
const { displayNames } = require('../notifications/triggers');

const REMINDER_ACTION_TYPE = 'appointment-reminder';
const REMINDERS_DOMAIN = 'appointment-reminders';

/** The action/notification key: one logical reminder per session slot. */
function reminderKey(sessionId, slot) {
  return `${REMINDER_ACTION_TYPE}:${sessionId}:${slot}`;
}

/** The organization's reminder configuration (normalized; never throws). */
function reminderSettings(configService, organizationKey) {
  return readDomain(configService, REMINDERS_DOMAIN, organizationKey).value;
}

/**
 * Register both halves of the reminder workflow:
 *  - the outbox consumer that SCHEDULES reminder actions for booked
 *    conversations (per-organization configuration gate at event time);
 *  - the scheduler handler that EXECUTES a due reminder by stating a
 *    notification intent (configuration re-checked, session re-read —
 *    event payloads and action payloads never carry contact details).
 *
 * @param {{
 *   outbox: { register: Function },
 *   scheduler: { register: Function, schedule: Function },
 *   store: { get: Function },
 *   notificationService: { send: Function },
 *   configService?: object|null,
 *   clock: import('../handoff/clock').Clock,
 * }} deps
 */
function registerAppointmentReminders({ outbox, scheduler, store, notificationService, configService = null, clock }) {
  outbox.register({
    consumer: 'appointment-reminders',
    eventTypes: ['conversation.completed'],
    async handle(event) {
      if (!event.payload || event.payload.status !== 'booked') return;
      const settings = reminderSettings(configService, event.organizationKey);
      if (!settings.enabled) return; // dark by default: event settles, nothing scheduled

      const session = await store.get(event.sessionId);
      const appointment = session && session.outcome && session.outcome.appointment;
      if (!appointment || !appointment.startsAt) return;
      const startsAtMs = Date.parse(appointment.startsAt);
      if (!Number.isFinite(startsAtMs)) return;

      for (const offset of settings.offsets) {
        const runAtMs = startsAtMs - offset.minutesBefore * 60_000;
        if (runAtMs <= clock.now()) continue; // inside the window: no backdated reminder
        // Structural dedupe by actionKey: replayed events cannot double-schedule.
        await scheduler.schedule({
          actionKey: reminderKey(event.sessionId, offset.slot),
          actionType: REMINDER_ACTION_TYPE,
          organizationKey: event.organizationKey,
          sessionId: event.sessionId,
          correlationId: event.correlationId ?? null,
          runAtMs,
          expiresAtMs: startsAtMs, // a reminder after the appointment never sends
          payload: { slot: offset.slot }, // safe facts only
        });
      }
    },
  });

  scheduler.register({
    actionType: REMINDER_ACTION_TYPE,
    async handle(action) {
      // Execution-time truth: the reminder reflects the CURRENT state of
      // the booking and configuration, not the state at scheduling time.
      if (!reminderSettings(configService, action.organizationKey).enabled) return; // disabled since: settle silently
      const session = await store.get(action.sessionId);
      if (!session || session.status !== 'booked') return; // no longer a booking: nothing to remind
      if (!session.caller || !session.caller.email) return;
      const appointment = session.outcome && session.outcome.appointment;
      if (!appointment) return;

      const names = displayNames(configService, action.organizationKey, session.scheduling || {});
      const result = await notificationService.send({
        type: 'appointment-reminder',
        organizationKey: action.organizationKey,
        // ADR-0011 key model with the schedule slot as qualifier — the
        // exactly-once customer effect under at-least-once execution.
        notificationKey: reminderKey(action.sessionId, action.payload.slot),
        recipient: { name: session.caller.fullName, email: session.caller.email },
        appointment: {
          startsAt: appointment.startsAt,
          timezone: appointment.timezone,
          attorneyName: names.attorneyName,
          consultationType: names.consultationType,
        },
      }, { correlationId: action.correlationId ?? undefined, sessionId: action.sessionId });

      // 'failed' is retryable delivery trouble: throw so the scheduler's
      // bounded retry re-attempts (the notification claim re-grants after
      // 'failed', and suppresses if another executor already sent).
      // 'sent'/'suppressed'/'not-configured' settle the action.
      if (result.status === 'failed') {
        throw new Error('reminder notification delivery failed; scheduler will retry');
      }
    },
  });
}

module.exports = {
  registerAppointmentReminders,
  reminderKey,
  REMINDER_ACTION_TYPE,
  REMINDERS_DOMAIN,
};
