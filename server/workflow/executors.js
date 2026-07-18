'use strict';

/**
 * Standard workflow intent executors (ADR-0021) — the composition seam
 * that wires declarative, identifier-only intents to the platform's
 * contracts. The engine knows none of these services; app.js registers
 * exactly the executors its composition can honor:
 *
 *   schedule-timeout  →  the Scheduler Contract (ADR-0018)
 *   notify            →  the Notification Contract (ADR-0011)
 *   integrate         →  the Integration Contract (ADR-0020) — registered
 *                        ONLY when an integration service is composed; a
 *                        workflow definition that never states integration
 *                        intents (the demonstration workflow) is fully
 *                        functional without it.
 *
 * The re-read discipline lives here: intents carry identifiers; business
 * truth (recipient, appointment) is re-read from the stores at execution
 * time, never snapshotted into workflow state.
 */

const { WORKFLOW_TIMEOUT_ACTION } = require('./engine');
const { displayNames } = require('../notifications/triggers');

/**
 * @param {{
 *   engine: ReturnType<typeof import('./engine').createWorkflowEngine>,
 *   scheduler: { schedule: Function },
 *   notificationService: { send: Function },
 *   handoffStore: { get: Function },
 *   integrationService?: { request: Function }|null,
 *   configService?: object|null,
 *   clock: import('../handoff/clock').Clock,
 * }} deps
 */
function registerStandardIntentExecutors({ engine, scheduler, notificationService, handoffStore, integrationService = null, configService = null, clock }) {
  // One-shot timeout through the existing scheduler. Structural dedupe by
  // actionKey: a replayed step cannot double-schedule.
  engine.registerIntentExecutor('schedule-timeout', async (intent, ctx) => {
    if (typeof intent.name !== 'string' || intent.name === '') {
      throw new TypeError('schedule-timeout intent requires a name');
    }
    const runAtMs = Number.isFinite(intent.dueAtMs) ? intent.dueAtMs : clock.now() + Number(intent.delayMs);
    if (!Number.isFinite(runAtMs)) throw new TypeError('schedule-timeout intent requires delayMs or dueAtMs');
    await scheduler.schedule({
      actionKey: `workflow-timeout:${ctx.instanceId}:${intent.name}`,
      actionType: WORKFLOW_TIMEOUT_ACTION,
      organizationKey: ctx.organizationKey,
      sessionId: intent.sessionId ?? null,
      correlationId: ctx.correlationId ?? null,
      runAtMs,
      payload: { instanceId: ctx.instanceId, timeoutName: intent.name },
    });
  });

  // A customer-visible step, stated through the Notification Contract.
  // Identifiers in the intent; recipient and appointment truth re-read
  // from the session at execution (the reminders discipline).
  engine.registerIntentExecutor('notify', async (intent, ctx) => {
    const session = await handoffStore.get(intent.sessionId);
    if (!session || !session.caller || !session.caller.email) return; // nothing to notify: settle
    const appointment = session.outcome && session.outcome.appointment;
    if (!appointment) return;

    const names = displayNames(configService, ctx.organizationKey, session.scheduling || {});
    const result = await notificationService.send({
      type: intent.notificationType,
      organizationKey: ctx.organizationKey,
      // ADR-0011 key model: exactly-once customer effect under
      // at-least-once step execution.
      notificationKey: `${intent.notificationType}:${intent.sessionId}:${intent.qualifier}`,
      recipient: { name: session.caller.fullName, email: session.caller.email },
      appointment: {
        startsAt: appointment.startsAt,
        timezone: appointment.timezone,
        attorneyName: names.attorneyName,
        consultationType: names.consultationType,
      },
    }, { correlationId: ctx.correlationId, sessionId: intent.sessionId });

    // 'failed' is retryable delivery trouble: throw so the step's bounded
    // retry re-attempts (the notification claim re-grants after 'failed'
    // and suppresses if another executor already sent).
    if (result.status === 'failed') {
      throw new Error('workflow notification delivery failed; the step will retry');
    }
  });

  // A system-to-system step, stated through the Integration Contract —
  // wired only where the composition provides the service.
  if (integrationService) {
    engine.registerIntentExecutor('integrate', async (intent, ctx) => {
      const { intent: _name, type, qualifier, ...facts } = intent;
      const result = await integrationService.request({
        type,
        organizationKey: ctx.organizationKey,
        integrationKey: `${type}:${qualifier}`,
        facts,
      }, { correlationId: ctx.correlationId });
      if (result.status === 'failed') {
        throw new Error('workflow integration delivery failed; the step will retry');
      }
    });
  }
}

module.exports = { registerStandardIntentExecutors };
