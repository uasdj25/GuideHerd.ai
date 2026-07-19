'use strict';

/**
 * The GuideHerd Workflow Contract (ADR-0021) — validation and registry for
 * durable multi-step business processes (Saga / Process Manager).
 *
 * A workflow DEFINITION is code (never a DSL), registered once:
 *
 *   {
 *     workflowType,      nonblank — the platform's extension key
 *     version,           positive integer. The DEFINITION VERSION CONTRACT:
 *                        an instance is permanently bound to the (type,
 *                        version) it began under; deploying a newer version
 *                        never alters existing instances; multiple versions
 *                        may be registered concurrently during migration;
 *                        NEW instances start under the highest registered
 *                        version (deterministic); resolving a version that
 *                        is no longer registered fails loudly
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
 * (workflowType, version), zero engine changes (ADR-0007).
 *
 * The version contract: registration and ACTIVATION are separate,
 * explicit operations. Registering a version never changes which version
 * starts new instances; `activate(type, version)` is the deliberate
 * selection, and it must name a registered definition or it fails loudly
 * (composition refuses to assemble). There is NO highest-wins, semver,
 * lexical, or numeric inference of any kind. EXISTING instances resolve
 * the exact (type, version) they were created under, forever. Multiple
 * versions register concurrently during a migration window — including
 * old versions kept registered purely so in-flight instances can finish,
 * without being startable. Resolving a (type, version) that is not
 * registered fails loudly, never a silent substitution.
 */
function createWorkflowDefinitionRegistry() {
  /** @type {Map<string, Map<number, object>>} type -> version -> definition */
  const byType = new Map();
  /** @type {Map<string, number>} type -> explicitly activated start version */
  const active = new Map();
  return {
    register(definition) {
      const valid = validateWorkflowDefinition(definition);
      const versions = byType.get(valid.workflowType) || new Map();
      if (versions.has(valid.version)) {
        throw new TypeError(`Workflow definition already registered: ${valid.workflowType}@${valid.version}`);
      }
      versions.set(valid.version, valid);
      byType.set(valid.workflowType, versions);
      return valid;
    },
    /** The exact definition an instance is bound to. Loud when absent. */
    resolve(workflowType, version) {
      const definition = byType.get(workflowType)?.get(version);
      if (!definition) {
        const err = new Error(`The workflow definition ${workflowType}@${version} is not registered.`);
        err.code = 'workflow_definition_unavailable';
        err.category = 'permanent_internal_failure';
        throw err;
      }
      return definition;
    },
    /**
     * Explicitly select the version that starts NEW instances of a type.
     * The deliberate operation the version contract requires: registering
     * a newer version changes nothing until this is called. Fails loudly
     * when the (type, version) is not registered — composition refuses to
     * assemble on a dangling activation.
     */
    activate(workflowType, version) {
      this.resolve(workflowType, version); // loud when unregistered
      active.set(workflowType, version);
      return this.resolve(workflowType, version);
    },
    /** The explicitly activated start version of a type, or null. */
    activeVersion(workflowType) {
      return active.has(workflowType) ? active.get(workflowType) : null;
    },
    /**
     * The definition NEW instances of a type start under: the explicitly
     * ACTIVATED version. Loud when the type has no activation — a type
     * registered without activation is resolution-only (a legitimate
     * migration posture for winding down old versions), never startable.
     */
    startDefinition(workflowType) {
      const version = active.get(workflowType);
      if (version === undefined) {
        const err = new Error(`No active version selected for workflow type ${workflowType}.`);
        err.code = 'workflow_definition_unavailable';
        err.category = 'permanent_internal_failure';
        throw err;
      }
      return this.resolve(workflowType, version);
    },
    /** One start definition per ACTIVATED type (the consumer's start loop). */
    startDefinitions() {
      return [...active.keys()].map((type) => this.startDefinition(type));
    },
    types() {
      return [...byType.keys()];
    },
    versions(workflowType) {
      return [...(byType.get(workflowType)?.keys() || [])].sort((a, b) => a - b);
    },
    /** Every registered definition, all versions (signal-source unions). */
    all() {
      return [...byType.values()].flatMap((versions) => [...versions.values()]);
    },
  };
}

module.exports = {
  validateWorkflowDefinition,
  validateSafeFacts,
  validateIntent,
  createWorkflowDefinitionRegistry,
};
