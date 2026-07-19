'use strict';

/**
 * The GuideHerd Workflow Engine (ADR-0021) — the transition engine for
 * durable multi-step business processes.
 *
 * The engine COMPOSES the platform; it replaces nothing:
 *
 *   durable outbox event ──▶ start / mid-flight signal
 *   scheduled action     ──▶ timeout signal          (via one actionType)
 *   transition intents   ──▶ registered intent executors
 *                            (notify / schedule-timeout / integrate — wired
 *                             at composition; the engine knows no services)
 *
 * Reliability is the platform's standard model, reused: instance creation
 * is idempotent by logical identity; transitions are atomic compare-and-
 * set WITH their steps; steps follow the claim discipline (atomic claim,
 * attempt counting, stale-claim recovery, bounded attempts →
 * 'abandoned'); drain() sits behind the existing liveness poller next to
 * the outbox and the scheduler. No second processing architecture.
 *
 * Idempotency under at-least-once signal delivery is structural, three
 * layers deep. Every signal carries a DURABLE IDENTITY (outbox event id;
 * timeout action identity), and the store records acceptance atomically
 * WITH the transition — a re-delivered or concurrently-delivered identity
 * is refused as a duplicate even if the instance has since returned to
 * the same state. Behind that, transition(state, signal) returning null
 * is the deterministic no-op, and step keys are deterministic per
 * transition so a racing duplicate appends nothing new. Downstream, the
 * Notification/Integration claim machines and the scheduler's actionKey
 * dedupe absorb any replayed intent.
 *
 * VERSIONING (ADR-0021): every instance is permanently bound to the
 * (workflowType, definitionVersion) it began under. New instances start
 * under the highest registered version; signals resolve the instance's
 * EXACT version — never latest — and a version missing from the registry
 * fails loudly, retried-bounded by the signal source.
 *
 * DARK BY DEFAULT: instances start only for organizations whose
 * `workflows` configuration domain enables the workflow type. Outbox,
 * Scheduler, Notifications, and Integrations remain completely unaware of
 * workflows — this module subscribes to their public seams.
 */

const crypto = require('node:crypto');

const { createWorkflowDefinitionRegistry, validateSafeFacts, validateIntent } = require('./contract');

const WORKFLOW_TIMEOUT_ACTION = 'workflow.timeout';
const WORKFLOWS_DOMAIN = 'workflows';
const DEFAULT_MAX_STEP_ATTEMPTS = 5;

/** Enabled workflow types for an organization (normalized; never throws). */
function enabledTypes(configService, organizationKey) {
  if (!configService || !organizationKey) return [];
  const { readDomain } = require('../configuration/framework');
  return readDomain(configService, WORKFLOWS_DOMAIN, organizationKey).value.enabledTypes;
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store').createInMemoryWorkflowStore>,
 *   outbox: { register: Function },
 *   scheduler: { register: Function, schedule: Function },
 *   configService?: object|null,
 *   clock: import('../handoff/clock').Clock,
 *   telemetry?: { event: Function },
 *   maxStepAttempts?: number,
 * }} deps
 */
function createWorkflowEngine({ store, outbox, scheduler, configService = null, clock, telemetry, maxStepAttempts = DEFAULT_MAX_STEP_ATTEMPTS }) {
  const registry = createWorkflowDefinitionRegistry();
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  /** @type {Map<string, Function>} intent name -> execute(intent, ctx) */
  const executors = new Map();
  let attached = false;

  const safeFields = (instance, extra = {}) => ({
    component: 'internal',
    operation: `workflow:${instance.workflowType}`,
    workflowType: instance.workflowType,
    instanceId: instance.instanceId,
    organizationKey: instance.organizationKey,
    sessionId: instance.relatedEntityId ?? undefined,
    correlationId: instance.correlationId ?? undefined,
    ...extra,
  });

  /**
   * The durable signal identity for deduplication. Outbox events carry
   * their durable event id; timeouts are identified by their scheduler
   * action identity (one-shot, actionKey-deduped). Identity strings only —
   * never payloads or free text.
   */
  function signalIdOf(instanceId, signal) {
    if (signal.kind === 'event') {
      const id = signal.event && signal.event.id;
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new TypeError('An event signal must carry the durable outbox event id (signal.event.id).');
      }
      return `event:${id}`;
    }
    if (signal.kind === 'timeout') {
      if (typeof signal.name !== 'string' || signal.name === '') {
        throw new TypeError('A timeout signal must carry its name.');
      }
      return `timeout:${instanceId}:${signal.name}`;
    }
    throw new TypeError(`Unknown signal kind: ${signal.kind}`);
  }

  /** Deterministic step keys: identical for any replay of one transition. */
  function stepsFor(instance, fromState, toState, intents) {
    return intents.map((raw, index) => {
      const intent = validateIntent(raw);
      return {
        stepKey: `${instance.instanceId}:${fromState}->${toState}:${index}`,
        instanceId: instance.instanceId,
        organizationKey: instance.organizationKey,
        correlationId: instance.correlationId ?? null,
        intent,
      };
    });
  }

  /**
   * Apply one signal to one instance. Idempotent: a signal the definition
   * does not transition on (including any duplicate) is a recorded no-op.
   */
  async function applySignal(instanceId, signal) {
    const instance = await store.get(instanceId);
    if (!instance) return { applied: false, reason: 'unknown-instance' };
    const signalId = signalIdOf(instanceId, signal);
    // Durable dedup fast path; the store re-checks ATOMICALLY inside the
    // transition, so this is an optimization, not the guarantee.
    if (await store.hasSignal(instanceId, signalId)) {
      return { applied: false, reason: 'duplicate-signal' };
    }
    // The instance's EXACT version — never latest (ADR-0021 versioning).
    const definition = registry.resolve(instance.workflowType, instance.definitionVersion);
    if (definition.terminalStates.includes(instance.state)) {
      return { applied: false, reason: 'terminal' };
    }
    const result = definition.transition(instance.state, signal, Object.freeze({ ...instance }));
    if (!result) {
      // A structurally valid signal the definition does not act on is
      // CONSUMED, not dropped: its identity commits durably (a state-
      // preserving CAS with zero steps) so a later replay can never become
      // a new business action after the instance moves to a state where
      // the stale delivery WOULD transition. If a concurrent transition
      // changed the state mid-evaluation, the CAS loses, nothing is
      // consumed, and redelivery re-evaluates against the new state —
      // exactly the at-least-once semantics required.
      const consumed = await store.transition(instanceId, instance.state, {
        toState: instance.state,
        stateData: instance.stateData,
        completedAtMs: instance.completedAtMs,
        steps: [],
        signalId,
        signalOutcome: 'ignored',
      });
      if (!consumed.applied) {
        return { applied: false, reason: consumed.duplicate ? 'duplicate-signal' : 'lost-race' };
      }
      return { applied: false, reason: 'ignored' };
    }

    const toState = result.nextState;
    const stateData = result.stateData !== undefined
      ? validateSafeFacts(result.stateData, 'workflow stateData')
      : instance.stateData;
    const terminal = definition.terminalStates.includes(toState);
    const steps = stepsFor(instance, instance.state, toState, result.intents || []);

    const outcome = await store.transition(instanceId, instance.state, {
      toState,
      stateData,
      completedAtMs: terminal ? clock.now() : null,
      steps,
      signalId,
    });
    if (!outcome.applied) {
      return { applied: false, reason: outcome.duplicate ? 'duplicate-signal' : 'lost-race' };
    }

    emit('workflow.transitioned', {
      severity: 'info',
      ...safeFields(instance, { fromState: instance.state, toState }),
    });
    if (terminal) {
      emit('workflow.completed', { severity: 'info', ...safeFields(instance, { toState }) });
    }
    await api.drain(); // inline nudge; the poller guarantees liveness
    return { applied: true, toState };
  }

  /**
   * Start (idempotently) an instance for a starting event, under the
   * highest registered version of its type. The initial intents ride a
   * self-transition carrying the event's durable signal identity — so a
   * crash between instance creation and intent recording is healed by the
   * redelivered event (the signal log makes the retry exact-once), and a
   * fully-processed duplicate event is a recorded no-op.
   */
  async function startFrom(definition, event) {
    const instanceKey = String(definition.startsOn.instanceKeyOf(event));
    const started = definition.start(event);
    const stateData = validateSafeFacts(started.stateData || {}, 'workflow stateData');
    const { created, instance } = await store.createInstance({
      instanceId: crypto.randomUUID(),
      workflowType: definition.workflowType,
      definitionVersion: definition.version,
      instanceKey,
      organizationKey: event.organizationKey,
      relatedEntityId: event.sessionId ?? null,
      state: started.state,
      stateData,
      correlationId: event.correlationId ?? null,
    });
    if (created) {
      emit('workflow.instance_started', { severity: 'info', ...safeFields(instance) });
    }

    if (started.intents && started.intents.length) {
      // Runs on creation AND on redelivery: the durable signal identity
      // makes it exactly-once, closing the crash window between creation
      // and intent recording. A redelivered event after full processing
      // is a duplicate-signal no-op.
      const signalId = `event:${event.id}`;
      if (!(await store.hasSignal(instance.instanceId, signalId))) {
        const steps = stepsFor(instance, 'start', instance.state, started.intents);
        await store.transition(instance.instanceId, instance.state, {
          toState: instance.state, stateData: instance.stateData, completedAtMs: null, steps, signalId,
        });
        await api.drain();
      }
    }
    return { started: created, instance };
  }

  const api = {
    store,
    registry,

    /** One definition + one registration per (workflowType, version) (ADR-0007). */
    register(definition) {
      return registry.register(definition);
    },

    /**
     * Explicitly select the version that starts NEW instances of a type —
     * the deliberate activation the version contract requires. Loud when
     * the (type, version) is not registered.
     */
    activate(workflowType, version) {
      return registry.activate(workflowType, version);
    },

    /**
     * Register an intent executor. Composition wires these to platform
     * services; the engine stays service-agnostic. A future intent kind is
     * one executor registration — zero engine changes.
     */
    registerIntentExecutor(name, execute) {
      if (typeof name !== 'string' || name === '' || typeof execute !== 'function') {
        throw new TypeError('An intent executor must declare a name and execute().');
      }
      if (executors.has(name)) throw new TypeError(`Intent executor already registered: ${name}`);
      executors.set(name, execute);
    },

    executorNames() {
      return [...executors.keys()];
    },

    /**
     * Attach the engine to the platform's signal sources: ONE outbox
     * consumer and ONE scheduler action type, registered through their
     * public seams — those contracts remain unaware of workflows.
     */
    attach() {
      if (attached) throw new TypeError('Workflow engine already attached.');
      attached = true;

      outbox.register({
        consumer: 'workflow-engine',
        // Definitions are registered before attach() at composition time;
        // subscribing to the union across ALL registered versions keeps
        // unrelated events settling instantly with no workflow involvement.
        eventTypes: [...new Set(registry.all().flatMap((d) => [
          d.startsOn.eventType,
          ...Object.keys(d.reactsTo || {}),
        ]))],
        handle: async (event) => {
          // Starts use one definition per type: the highest registered
          // version (ADR-0021). Mid-flight signals below resolve each
          // instance's own recorded version.
          for (const definition of registry.startDefinitions()) {
            if (!enabledTypes(configService, event.organizationKey).includes(definition.workflowType)) continue;
            if (definition.startsOn.eventType === event.type
              && (!definition.startsOn.when || definition.startsOn.when(event))) {
              await startFrom(definition, event);
            }
            const reactsKeyOf = (definition.reactsTo || {})[event.type];
            if (reactsKeyOf) {
              const instance = await store.findByKey(definition.workflowType, String(reactsKeyOf(event)));
              // applySignal resolves the INSTANCE's version, which may
              // differ from the start definition consulted for the key.
              if (instance) await applySignal(instance.instanceId, { kind: 'event', name: event.type, event });
            }
          }
        },
      });

      scheduler.register({
        actionType: WORKFLOW_TIMEOUT_ACTION,
        handle: async (action) => {
          // Idempotent under scheduler retries: a duplicate timeout finds
          // the instance already transitioned and no-ops.
          await applySignal(action.payload.instanceId, { kind: 'timeout', name: action.payload.timeoutName });
        },
      });
    },

    /**
     * Execute claimable steps: the platform's claim discipline — atomic
     * claim, bounded attempts, stale-claim recovery, 'abandoned' at the
     * bound. Sits behind the existing liveness poller (server.js) next to
     * outbox.drain() and scheduler.drain(); overlapping drains coalesce.
     */
    async drain() {
      if (api._draining) return api._draining;
      api._draining = (async () => {
        try {
          const claimed = await store.claimSteps({ maxAttempts: maxStepAttempts, limit: 100 });
          for (const step of claimed) {
            const fields = {
              component: 'internal',
              operation: `workflow-step:${step.intent.intent}`,
              stepKey: step.stepKey,
              instanceId: step.instanceId,
              organizationKey: step.organizationKey,
              correlationId: step.correlationId ?? undefined,
              intent: step.intent.intent,
              attempt: step.attempts,
              maxAttempts: maxStepAttempts,
            };
            try {
              const execute = executors.get(step.intent.intent);
              if (!execute) throw new TypeError(`No intent executor registered: ${step.intent.intent}`);
              await execute(step.intent, {
                instanceId: step.instanceId,
                organizationKey: step.organizationKey,
                correlationId: step.correlationId ?? undefined,
              });
              await store.markStepCompleted(step.stepKey);
            } catch (err) {
              const { abandoned } = await store.markStepFailed(step.stepKey, { maxAttempts: maxStepAttempts });
              emit(abandoned ? 'workflow.step_abandoned' : 'workflow.step_failed', {
                severity: abandoned ? 'error' : 'warn',
                ...fields,
                code: err && err.code ? err.code : undefined,
              });
            }
          }
        } finally {
          api._draining = null;
        }
      })();
      return api._draining;
    },

    /** Exposed for tests and the scheduler/consumer paths. */
    applySignal,
  };

  return api;
}

module.exports = { createWorkflowEngine, WORKFLOW_TIMEOUT_ACTION, WORKFLOWS_DOMAIN, DEFAULT_MAX_STEP_ATTEMPTS, enabledTypes };
