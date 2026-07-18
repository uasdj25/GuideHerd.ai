'use strict';

/**
 * Shared Workflow store contract suite (ADR-0021).
 *
 * Every guarantee of the durable workflow state contract, expressed
 * against the store CONTRACT rather than an implementation — the same
 * suite runs against the in-memory reference store and the PostgreSQL
 * store, so the two can never drift apart silently.
 *
 * All data is synthetic. All time comes from the injected fixed clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { fixedClock } = require('../handoff/clock');
const { STALE_CLAIM_MS } = require('../handoff/store');

const T0 = Date.parse('2026-07-12T15:15:00Z');

function makeInstance(overrides = {}) {
  const id = crypto.randomUUID();
  return {
    instanceId: id,
    workflowType: 'demo-follow-up',
    definitionVersion: 1,
    instanceKey: overrides.instanceKey ?? `sess-${id}`,
    organizationKey: 'org-a',
    relatedEntityId: 'sess-1',
    state: 'awaiting-follow-up',
    stateData: { sessionId: 'sess-1' },
    correlationId: 'gh-wf',
    ...overrides,
  };
}

function makeStep(instanceId, stepKey, intent = { intent: 'notify', sessionId: 'sess-1' }) {
  return { stepKey, instanceId, organizationKey: 'org-a', correlationId: 'gh-wf', intent };
}

/**
 * @param {string} label suite label ('memory' | 'postgres')
 * @param {(deps: { clock: import('../handoff/clock').Clock }) => Promise<object>} makeStore
 */
function runWorkflowStoreContractSuite(label, makeStore) {
  test(`workflow store [${label}]: instance creation is idempotent by logical identity`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const record = makeInstance({ instanceKey: `dup-${crypto.randomUUID()}` });

    const first = await store.createInstance(record);
    assert.equal(first.created, true);
    // A duplicate durable event tries again with a NEW instanceId but the
    // SAME logical identity — it must find the original, never duplicate.
    const second = await store.createInstance({ ...record, instanceId: crypto.randomUUID() });
    assert.equal(second.created, false);
    assert.equal(second.instance.instanceId, first.instance.instanceId);
    assert.deepEqual(second.instance.stateData, { sessionId: 'sess-1' });
    assert.equal(await store.findByKey(record.workflowType, record.instanceKey)
      .then((i) => i.instanceId), first.instance.instanceId);
    await store.close();
  });

  test(`workflow store [${label}]: transition is an atomic CAS with its steps — both or neither`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { instance } = await store.createInstance(makeInstance());
    const stepKey = `${instance.instanceId}:awaiting-follow-up->completed:0`;

    // A CAS from the WRONG state applies nothing — no state change, no steps.
    const lost = await store.transition(instance.instanceId, 'not-the-state', {
      toState: 'completed', stateData: {}, steps: [makeStep(instance.instanceId, stepKey)],
    });
    assert.equal(lost.applied, false);
    assert.equal((await store.get(instance.instanceId)).state, 'awaiting-follow-up');
    assert.equal(await store.getStep(stepKey), undefined, 'a lost CAS writes no steps');

    // The correct CAS advances and records the steps atomically.
    const won = await store.transition(instance.instanceId, 'awaiting-follow-up', {
      toState: 'completed', stateData: { sessionId: 'sess-1' }, completedAtMs: clock.now(),
      steps: [makeStep(instance.instanceId, stepKey)],
    });
    assert.equal(won.applied, true);
    const after = await store.get(instance.instanceId);
    assert.equal(after.state, 'completed');
    assert.equal(after.completedAtMs, T0);
    assert.equal((await store.getStep(stepKey)).status, 'pending');

    // Replaying the SAME transition (duplicate signal race): CAS fails,
    // the deterministic step key means nothing new is written.
    const replay = await store.transition(instance.instanceId, 'awaiting-follow-up', {
      toState: 'completed', stateData: {}, steps: [makeStep(instance.instanceId, stepKey)],
    });
    assert.equal(replay.applied, false);
    await store.close();
  });

  test(`workflow store [${label}]: the definition version an instance began under is persisted verbatim`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { instance } = await store.createInstance(makeInstance({ definitionVersion: 3 }));
    assert.equal(instance.definitionVersion, 3);
    assert.equal((await store.get(instance.instanceId)).definitionVersion, 3);
    // A duplicate event under a NEWER deployed version cannot rebind the
    // instance: the original version record wins (ADR-0021 versioning).
    const dup = await store.createInstance({ ...makeInstance({ definitionVersion: 4 }),
      instanceKey: instance.instanceKey, instanceId: crypto.randomUUID() });
    assert.equal(dup.created, false);
    assert.equal(dup.instance.definitionVersion, 3);
    await store.close();
  });

  test(`workflow store [${label}]: signal acceptance is atomic with the transition and durably deduplicated`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { instance } = await store.createInstance(makeInstance({ state: 'a' }));
    const id = instance.instanceId;
    const step = (k) => makeStep(id, `${id}:${k}`);

    // First delivery of the signal identity: accepted with the transition.
    assert.equal((await store.hasSignal(id, 'event:evt-1')), false);
    const first = await store.transition(id, 'a', { toState: 'b', stateData: {}, steps: [step('a->b:0')], signalId: 'event:evt-1' });
    assert.deepEqual(first, { applied: true });
    assert.equal(await store.hasSignal(id, 'event:evt-1'), true);

    // The instance RETURNS to state 'a' via a different signal…
    await store.transition(id, 'b', { toState: 'a', stateData: {}, steps: [], signalId: 'event:evt-2' });
    // …and the ORIGINAL signal identity is re-delivered: a state-only CAS
    // would wrongly re-fire a->b; the durable signal log refuses it.
    const replay = await store.transition(id, 'a', { toState: 'b', stateData: {}, steps: [step('a->b:1')], signalId: 'event:evt-1' });
    assert.deepEqual(replay, { applied: false, duplicate: true });
    assert.equal((await store.get(id)).state, 'a', 'the duplicate changed nothing');
    assert.equal(await store.getStep(`${id}:a->b:1`), undefined, 'the duplicate recorded no intents');

    // A transition that loses its CAS records NEITHER the signal nor steps
    // — acceptance and transition are one atomic unit, so a pre-commit
    // failure is safely retryable.
    const lost = await store.transition(id, 'not-the-state', { toState: 'z', stateData: {}, steps: [step('x:0')], signalId: 'event:evt-3' });
    assert.equal(lost.applied, false);
    assert.equal(await store.hasSignal(id, 'event:evt-3'), false, 'no signal recorded on a failed transition');
    const retry = await store.transition(id, 'a', { toState: 'c', stateData: {}, steps: [], signalId: 'event:evt-3' });
    assert.deepEqual(retry, { applied: true }, 'the failed delivery retried safely');
    await store.close();
  });

  test(`workflow store [${label}]: signal records carry identity strings only`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { instance } = await store.createInstance(makeInstance());
    await store.transition(instance.instanceId, 'awaiting-follow-up', {
      toState: 'completed', stateData: {}, steps: [], signalId: 'timeout:x:follow-up',
    });
    // The dedup surface exposes nothing but a boolean — no payload storage
    // exists to leak. (The PostgreSQL table stores instance_id + signal_id
    // + timestamp only, by schema.)
    assert.equal(await store.hasSignal(instance.instanceId, 'timeout:x:follow-up'), true);
    await store.close();
  });

  test(`workflow store [${label}]: step claims are atomic, counted, stale-recoverable, and bounded`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { instance } = await store.createInstance(makeInstance());
    const stepKey = `${instance.instanceId}:a->b:0`;
    await store.transition(instance.instanceId, 'awaiting-follow-up', {
      toState: 'b', stateData: {}, steps: [makeStep(instance.instanceId, stepKey)],
    });

    // First claim wins and counts the attempt; a fresh claim is refused.
    const first = await store.claimSteps({ maxAttempts: 3, limit: 10 });
    assert.equal(first.length, 1);
    assert.equal(first[0].attempts, 1);
    assert.equal((await store.claimSteps({ maxAttempts: 3, limit: 10 })).length, 0, 'fresh claim blocks');

    // Stale claim (executor crashed): recoverable after the window.
    clock.set(T0 + STALE_CLAIM_MS);
    const recovered = await store.claimSteps({ maxAttempts: 3, limit: 10 });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].attempts, 2);

    // A failure below the bound re-claims immediately; at the bound it abandons.
    assert.deepEqual(await store.markStepFailed(stepKey, { maxAttempts: 3 }), { abandoned: false });
    const third = await store.claimSteps({ maxAttempts: 3, limit: 10 });
    assert.equal(third.length, 1);
    assert.equal(third[0].attempts, 3);
    assert.deepEqual(await store.markStepFailed(stepKey, { maxAttempts: 3 }), { abandoned: true });
    assert.equal((await store.getStep(stepKey)).status, 'abandoned');
    assert.equal((await store.claimSteps({ maxAttempts: 3, limit: 10 })).length, 0, 'abandoned is final');
    await store.close();
  });

  test(`workflow store [${label}]: completed steps never re-claim; listInstances is newest-first identifiers only`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { instance } = await store.createInstance(makeInstance());
    const stepKey = `${instance.instanceId}:a->b:0`;
    await store.transition(instance.instanceId, 'awaiting-follow-up', {
      toState: 'b', stateData: {}, steps: [makeStep(instance.instanceId, stepKey)],
    });
    await store.claimSteps({ maxAttempts: 3, limit: 10 });
    await store.markStepCompleted(stepKey);
    clock.set(T0 + STALE_CLAIM_MS * 2);
    assert.equal((await store.claimSteps({ maxAttempts: 3, limit: 10 })).length, 0, 'completed is final');

    clock.set(T0 + STALE_CLAIM_MS * 2 + 1000);
    await store.createInstance(makeInstance());
    const listed = await store.listInstances({ limit: 10 });
    assert.ok(listed.length >= 2);
    assert.ok(listed[0].createdAtMs >= listed[1].createdAtMs, 'newest first');
    for (const item of listed) {
      assert.ok(!JSON.stringify(item).match(/@|caller|email|phone/i), 'identifiers and safe facts only');
    }
    await store.close();
  });
}

module.exports = { runWorkflowStoreContractSuite };
