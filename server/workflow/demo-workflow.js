'use strict';

/**
 * The demonstration workflow (ADR-0021) — deliberately minimal and
 * clearly synthetic. It exists to prove the Workflow Contract's
 * composition end to end with REAL platform machinery and NO new
 * mechanisms:
 *
 *   conversation.completed (booked)      a real durable outbox event
 *     └─ instance 'awaiting-follow-up'   durable workflow state
 *          └─ schedule-timeout intent    a real one-shot scheduled action
 *               └─ timeout signal        deterministic transition
 *                    └─ notify intent    a real Notification Contract
 *                       'completed'      intent, then the terminal state
 *
 * DARK BY DEFAULT: no organization runs this workflow until the
 * `workflows` configuration domain lists 'demo-follow-up' in its
 * enabledTypes. State carries identifiers only (the sessionId); the
 * caller's details are re-read from the session at the notify step.
 *
 * This is NOT a production intake workflow. Real workflows (intake,
 * document requests, escalations) arrive as their own definitions on this
 * foundation — one definition + one registration each, zero engine
 * changes.
 */

const DEMO_WORKFLOW_TYPE = 'demo-follow-up';
const FOLLOW_UP_TIMEOUT = 'follow-up';
const DEFAULT_FOLLOW_UP_DELAY_MS = 60 * 60 * 1000; // one hour after booking

function createDemoWorkflowDefinition({ followUpDelayMs = DEFAULT_FOLLOW_UP_DELAY_MS } = {}) {
  return {
    workflowType: DEMO_WORKFLOW_TYPE,
    version: 1,

    startsOn: {
      eventType: 'conversation.completed',
      when: (event) => Boolean(event.payload && event.payload.status === 'booked'),
      // One instance per booked session, ever — duplicate outcome events
      // cannot start duplicates.
      instanceKeyOf: (event) => event.sessionId,
    },

    start(event) {
      return {
        state: 'awaiting-follow-up',
        stateData: { sessionId: event.sessionId }, // identifiers only
        intents: [{
          intent: 'schedule-timeout',
          name: FOLLOW_UP_TIMEOUT,
          delayMs: followUpDelayMs,
          sessionId: event.sessionId,
        }],
      };
    },

    /**
     * Deterministic: (current state, signal) → next state + intents.
     * Anything else — including every duplicate signal — is null: the
     * idempotent no-op.
     */
    transition(state, signal, instance) {
      if (state === 'awaiting-follow-up' && signal.kind === 'timeout' && signal.name === FOLLOW_UP_TIMEOUT) {
        return {
          nextState: 'completed',
          intents: [{
            intent: 'notify',
            notificationType: 'appointment-reminder',
            sessionId: instance.stateData.sessionId,
            qualifier: DEMO_WORKFLOW_TYPE,
          }],
        };
      }
      return null;
    },

    terminalStates: ['completed'],
  };
}

module.exports = { createDemoWorkflowDefinition, DEMO_WORKFLOW_TYPE, FOLLOW_UP_TIMEOUT };
