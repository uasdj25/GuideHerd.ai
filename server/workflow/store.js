'use strict';

/**
 * Workflow instance store — in-memory reference implementation of the
 * durable workflow state contract (ADR-0021).
 *
 * Guarantees (shared with the PostgreSQL implementation in
 * server/operational/workflow-store.js, verified by one contract suite):
 *
 *  - CREATE is idempotent by logical identity: one instance per
 *    (workflowType, instanceKey), ever — a duplicate durable event cannot
 *    start a duplicate instance. Every instance records the DEFINITION
 *    VERSION it began under (ADR-0021 versioning contract).
 *  - TRANSITION is an atomic compare-and-set on the current state, and the
 *    transition's SIGNAL ACCEPTANCE and steps are recorded IN THE SAME
 *    atomic operation — a transition either accepts the signal, advances
 *    the state, and durably records its intents, or does none of them.
 *    Signal identities are durable and per-instance unique: re-delivery of
 *    an accepted signalId is refused as a duplicate even if the instance
 *    has since returned to the same state (a state-only CAS could not
 *    catch that). Step keys are deterministic, and appends are idempotent
 *    by key, so a lost race writes nothing new. Signal records hold the
 *    identity string only — never payloads or free text.
 *  - STEPS carry identifier-only intents and follow the platform's claim
 *    discipline: atomic claim with attempt counting, stale-claim recovery,
 *    bounded attempts, then 'abandoned' — never an unbounded retry.
 *
 * In-memory atomicity: one synchronous pass per operation, no `await` in
 * the middle — the platform's standard single-process guarantee.
 */

const { STALE_CLAIM_MS } = require('../handoff/store');

function createInMemoryWorkflowStore({ clock }) {
  /** @type {Map<string, object>} instanceId -> instance record */
  const instances = new Map();
  /** @type {Map<string, string>} `${workflowType} ${instanceKey}` -> instanceId */
  const byKey = new Map();
  /** @type {Map<string, object>} stepKey -> step record */
  const steps = new Map();
  /** @type {Map<string, Map<string, string>>} instanceId -> signalId -> outcome */
  const signals = new Map();

  const logical = (workflowType, instanceKey) => `${workflowType} ${instanceKey}`;
  const publicInstance = (r) => ({ ...r, stateData: { ...r.stateData } });
  const publicStep = (r) => ({ ...r, intent: { ...r.intent } });

  return {
    /**
     * Create an instance idempotently by (workflowType, instanceKey).
     * @returns {Promise<{ created: boolean, instance: object }>}
     */
    async createInstance(record) {
      const key = logical(record.workflowType, record.instanceKey);
      const existingId = byKey.get(key);
      if (existingId) return { created: false, instance: publicInstance(instances.get(existingId)) };
      const instance = {
        instanceId: record.instanceId,
        workflowType: record.workflowType,
        definitionVersion: record.definitionVersion,
        instanceKey: record.instanceKey,
        organizationKey: record.organizationKey,
        relatedEntityId: record.relatedEntityId ?? null,
        state: record.state,
        stateData: { ...(record.stateData || {}) },
        correlationId: record.correlationId ?? null,
        createdAtMs: clock.now(),
        updatedAtMs: clock.now(),
        completedAtMs: record.completedAtMs ?? null,
      };
      instances.set(instance.instanceId, instance);
      byKey.set(key, instance.instanceId);
      return { created: true, instance: publicInstance(instance) };
    },

    async get(instanceId) {
      const record = instances.get(instanceId);
      return record ? publicInstance(record) : undefined;
    },

    async findByKey(workflowType, instanceKey) {
      const id = byKey.get(logical(workflowType, instanceKey));
      return id ? publicInstance(instances.get(id)) : undefined;
    },

    /** Has this instance already CONSUMED this signal identity? */
    async hasSignal(instanceId, signalId) {
      return Boolean(signals.get(instanceId)?.has(signalId));
    },

    /** The consumption record (tests/introspection): identity + outcome only. */
    async getSignal(instanceId, signalId) {
      const outcome = signals.get(instanceId)?.get(signalId);
      return outcome === undefined ? undefined : { signalId, outcome };
    },

    /**
     * Atomic compare-and-set transition WITH its signal acceptance and its
     * steps: the signal identity is recorded, the state advances, and the
     * intents are recorded in one indivisible operation — or nothing
     * happens at all. A previously-accepted signalId is refused as a
     * duplicate regardless of state.
     * @returns {Promise<{ applied: boolean, duplicate?: boolean }>}
     */
    async transition(instanceId, fromState, { toState, stateData, completedAtMs = null, steps: newSteps = [], signalId, signalOutcome = 'transitioned' }) {
      const accepted = signals.get(instanceId);
      if (signalId && accepted && accepted.has(signalId)) return { applied: false, duplicate: true };
      const record = instances.get(instanceId);
      if (!record || record.state !== fromState) return { applied: false };
      if (signalId) {
        if (!accepted) signals.set(instanceId, new Map([[signalId, signalOutcome]]));
        else accepted.set(signalId, signalOutcome);
      }
      record.state = toState;
      if (stateData !== undefined) record.stateData = { ...stateData };
      record.updatedAtMs = clock.now();
      record.completedAtMs = completedAtMs;
      for (const step of newSteps) {
        if (steps.has(step.stepKey)) continue; // idempotent by deterministic key
        steps.set(step.stepKey, {
          stepKey: step.stepKey,
          instanceId: step.instanceId,
          organizationKey: step.organizationKey,
          correlationId: step.correlationId ?? null,
          intent: { ...step.intent },
          status: 'pending',
          attempts: 0,
          claimedAtMs: null,
          createdAtMs: clock.now(),
        });
      }
      return { applied: true };
    },

    /**
     * Atomically claim executable steps: pending, never-claimed or
     * stale-claimed, attempts below the bound. Claiming counts an attempt.
     */
    async claimSteps({ maxAttempts, limit = 100 }) {
      const now = clock.now();
      const staleBefore = now - STALE_CLAIM_MS;
      const claimed = [];
      const candidates = [...steps.values()]
        .filter((s) => s.status === 'pending' && s.attempts < maxAttempts
          && (s.claimedAtMs === null || s.claimedAtMs <= staleBefore))
        .sort((a, b) => a.createdAtMs - b.createdAtMs || a.stepKey.localeCompare(b.stepKey))
        .slice(0, Math.max(1, limit));
      for (const step of candidates) {
        step.claimedAtMs = now;
        step.attempts += 1;
        claimed.push(publicStep(step));
      }
      return claimed;
    },

    async markStepCompleted(stepKey) {
      const step = steps.get(stepKey);
      if (step) step.status = 'completed';
    },

    /**
     * Record a failed execution: re-claimable until the attempt bound,
     * then 'abandoned'.
     * @returns {Promise<{ abandoned: boolean }>}
     */
    async markStepFailed(stepKey, { maxAttempts }) {
      const step = steps.get(stepKey);
      if (!step) return { abandoned: false };
      if (step.attempts >= maxAttempts) {
        step.status = 'abandoned';
        return { abandoned: true };
      }
      step.claimedAtMs = null; // immediately re-claimable on the next drain
      return { abandoned: false };
    },

    /** Introspection (tests, generic visibility): instances, newest first. */
    async listInstances({ limit = 50 } = {}) {
      return [...instances.values()]
        .sort((a, b) => b.createdAtMs - a.createdAtMs || a.instanceId.localeCompare(b.instanceId))
        .slice(0, Math.max(1, limit))
        .map(publicInstance);
    },

    /** Introspection (tests): a step by key. */
    async getStep(stepKey) {
      const step = steps.get(stepKey);
      return step ? publicStep(step) : undefined;
    },

    async close() {},
  };
}

module.exports = { createInMemoryWorkflowStore };
