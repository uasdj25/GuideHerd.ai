'use strict';

/**
 * The GuideHerd Workflow Contract (ADR-0021) — validation and registry for
 * durable multi-step business processes (Saga / Process Manager).
 *
 * A workflow DEFINITION is code (never a DSL), registered once:
 *
 *   {
 *     workflowType,      nonblank, unique — the platform's extension key
 *     version,           positive integer (definition evolution marker)
 *     startsOn: {
 *       eventType,       the durable outbox event that starts an instance
 *       when?(event),    optional guard over the event's safe facts
 *       instanceKeyOf(event),  the logical identity — one instance per
 *                        (workflowType, instanceKey), ever; duplicate
 *                        events cannot start duplicates
 *     },
 *     reactsTo?: {       optional mid-flight event subscriptions:
 *       [eventType]: instanceKeyOf(event)
 *     },
 *     start(event) -> { state, stateData?, intents? }
 *     transition(state, signal, instance) -> null | { nextState, stateData?, intents? }
 *                        DETERMINISTIC: (current state, signal) alone
 *                        decide. Returning null is the idempotent no-op —
 *                        an unexpected or duplicate signal changes nothing.
 *     terminalStates: [...]  states from which no signal transitions
 *   }
 *
 * Signals are the platform's existing machinery only:
 *   { kind: 'event',   name: eventType, event }   durable outbox events
 *   { kind: 'timeout', name }                      scheduled one-shots
 *
 * INSTANCES are durable platform state, never customer-record snapshots:
 * identifiers, safe workflow facts, correlation, state, timestamps.
 * Business truth is re-read at step execution. `stateData` is therefore
 * validated to bounded scalars, exactly like integration facts.
 *
 * INTENTS are declarative, identifier-only descriptors executed by
 * registered intent executors (composition wires executors to the
 * Notification Contract, the Scheduler, and — where composed — the
 * Integration Contract; the engine knows none of those services).
 */

const LIMITS = Object.freeze({ string: 254, keys: 32 });

function isNonblank(v, max = LIMITS.string) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

/** Validate a safe-facts object: bounded scalars, bounded key count. */
function validateSafeFacts(facts, label) {
  const fail = (reason) => { throw new TypeError(`Invalid ${label}: ${reason}`); };
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) fail('not an object');
  const keys = Object.keys(facts);
  if (keys.length > LIMITS.keys) fail('too many keys');
  const canonical = {};
  for (const key of keys) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) fail(`key ${key} is not a plain identifier`);
    const value = facts[key];
    const scalar = (typeof value === 'string' && value.length <= LIMITS.string)
      || typeof value === 'number' || typeof value === 'boolean' || value === null;
    if (!scalar) fail(`${key} must be a bounded scalar`);
    canonical[key] = typeof value === 'string' ? value.trim() : value;
  }
  return canonical;
}

/** Validate an intent descriptor: a named, identifier-only instruction. */
function validateIntent(intent) {
  const fail = (reason) => { throw new TypeError(`Invalid workflow intent: ${reason}`); };
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) fail('not an object');
  if (!isNonblank(intent.intent, 64)) fail('intent name required');
  const { intent: name, ...facts } = intent;
  return { intent: name.trim(), ...validateSafeFacts(facts, 'workflow intent facts') };
}

/** Validate a workflow definition (a registration-time programming contract). */
function validateWorkflowDefinition(definition) {
  const fail = (reason) => { throw new TypeError(`Invalid workflow definition: ${reason}`); };
  if (definition === null || typeof definition !== 'object') fail('not an object');
  if (!isNonblank(definition.workflowType, 64) || !/^[a-z][a-z0-9-]*$/.test(definition.workflowType)) {
    fail('workflowType must be a nonblank kebab-case key');
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) fail('version must be a positive integer');
  const startsOn = definition.startsOn;
  if (!startsOn || !isNonblank(startsOn.eventType, 128)) fail('startsOn.eventType required');
  if (typeof startsOn.instanceKeyOf !== 'function') fail('startsOn.instanceKeyOf() required');
  if (startsOn.when !== undefined && typeof startsOn.when !== 'function') fail('startsOn.when must be a function');
  if (typeof definition.start !== 'function') fail('start() required');
  if (typeof definition.transition !== 'function') fail('transition() required');
  if (!Array.isArray(definition.terminalStates) || definition.terminalStates.length === 0) {
    fail('terminalStates required');
  }
  if (definition.reactsTo !== undefined) {
    if (definition.reactsTo === null || typeof definition.reactsTo !== 'object') fail('reactsTo must be an object');
    for (const [eventType, fn] of Object.entries(definition.reactsTo)) {
      if (!isNonblank(eventType, 128) || typeof fn !== 'function') fail('reactsTo maps eventType -> instanceKeyOf()');
    }
  }
  return definition;
}

/**
 * Workflow definition registry — one definition + one registration per
 * workflow type, zero engine changes (ADR-0007). Unknown types fail
 * loudly, never a silent substitute.
 */
function createWorkflowDefinitionRegistry() {
  /** @type {Map<string, object>} */
  const definitions = new Map();
  return {
    register(definition) {
      const valid = validateWorkflowDefinition(definition);
      if (definitions.has(valid.workflowType)) {
        throw new TypeError(`Workflow definition already registered: ${valid.workflowType}`);
      }
      definitions.set(valid.workflowType, valid);
      return valid;
    },
    resolve(workflowType) {
      const definition = definitions.get(workflowType);
      if (!definition) {
        const err = new Error('The requested workflow definition is not registered.');
        err.code = 'workflow_definition_unavailable';
        err.category = 'permanent_internal_failure';
        throw err;
      }
      return definition;
    },
    types() {
      return [...definitions.keys()];
    },
    all() {
      return [...definitions.values()];
    },
  };
}

module.exports = {
  validateWorkflowDefinition,
  validateSafeFacts,
  validateIntent,
  createWorkflowDefinitionRegistry,
};
