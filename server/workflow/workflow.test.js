'use strict';

/**
 * GuideHerd Workflow Contract tests (ADR-0021).
 *
 * Covers the definition contract and registry, the store contract
 * (in-memory leg of the shared suite — the PostgreSQL leg runs in
 * server/operational/operational.test.js), the engine's determinism and
 * idempotency under at-least-once signals, dark-by-default enablement,
 * step retry/abandonment, the standard intent executors, semantic
 * independence from the Integration Contract, and the demonstration
 * workflow end to end through the REAL composed application: a real
 * durable event, a real scheduled timeout, a real notification intent, a
 * terminal state. Deterministic: fixed clocks, synthetic data, no
 * network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createApp } = require('../handoff/app');
const { makeSession, BOOKED_OUTCOME } = require('../operational/contract-suite');
const { readDomain, validateDomain } = require('../configuration/framework');

const { validateWorkflowDefinition, validateSafeFacts, validateIntent, createWorkflowDefinitionRegistry } = require('./contract');

const { createInMemoryWorkflowStore } = require('./store');
const { runWorkflowStoreContractSuite } = require('./store-contract-suite');
const { createDemoWorkflowDefinition, DEMO_WORKFLOW_TYPE } = require('./demo-workflow');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const FIRM = 'martinson-beason';
const HOUR_MS = 60 * 60 * 1000;

function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  return configService;
}

/** A composed app with fixed time; the REAL wiring, in-memory stores. */
function composedApp({ configService = configServiceWithFirm(), clock = fixedClock(T0) } = {}) {
  const lines = [];
  const { createTelemetry } = require('../telemetry/telemetry');
  const app = createApp({
    clock,
    configService,
    mailer: { enabled: false },
    telemetry: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock }),
  });
  return { app, clock, configService, lines };
}

/** Drive one synthetic booked session through the real store + outbox. */
async function bookSession(app, { firmId = FIRM } = {}) {
  const { session } = makeSession({ firmId });
  await app.store.create(session);
  await app.store.redeem(session.tokenHash);
  await app.store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME }, { correlationId: 'gh-wf-test' });
  await app.outbox.drain(); // deliver conversation.completed to consumers
  return session;
}

// ── Definition contract and registry ────────────────────────────────────────

test('contract: definitions validate structurally; the registry is loud and duplicate-safe', () => {
  const good = createDemoWorkflowDefinition();
  assert.equal(validateWorkflowDefinition(good), good);
  assert.throws(() => validateWorkflowDefinition({ ...good, workflowType: 'Bad Type' }), /kebab-case/);
  assert.throws(() => validateWorkflowDefinition({ ...good, version: 0 }), /positive integer/);
  assert.throws(() => validateWorkflowDefinition({ ...good, startsOn: { eventType: 'x' } }), /instanceKeyOf/);
  assert.throws(() => validateWorkflowDefinition({ ...good, transition: undefined }), /transition/);
  assert.throws(() => validateWorkflowDefinition({ ...good, terminalStates: [] }), /terminalStates/);

  const registry = createWorkflowDefinitionRegistry();
  registry.register(good);
  assert.deepEqual(registry.types(), [DEMO_WORKFLOW_TYPE]);
  assert.throws(() => registry.register(createDemoWorkflowDefinition()), /already registered/);
  assert.throws(() => registry.resolve('client-intake'),
    (e) => e.code === 'workflow_definition_unavailable');
});

test('contract: state data and intents are identifier-safe bounded scalars — snapshots cannot ride along', () => {
  assert.deepEqual(validateSafeFacts({ sessionId: ' sess-1 ', count: 2, flag: true, gone: null }, 'x'),
    { sessionId: 'sess-1', count: 2, flag: true, gone: null });
  assert.throws(() => validateSafeFacts({ caller: { fullName: 'PII' } }, 'x'), /bounded scalar/);
  assert.throws(() => validateSafeFacts({ notes: 'y'.repeat(300) }, 'x'), /bounded scalar/);
  assert.throws(() => validateSafeFacts({ 'weird key': 1 }, 'x'), /plain identifier/);
  assert.deepEqual(validateIntent({ intent: 'notify', sessionId: 's1' }), { intent: 'notify', sessionId: 's1' });
  assert.throws(() => validateIntent({ sessionId: 's1' }), /intent name required/);
});

// ── Store contract (in-memory leg) ──────────────────────────────────────────

runWorkflowStoreContractSuite('memory', async ({ clock }) => createInMemoryWorkflowStore({ clock }));

// ── The demonstration workflow, end to end through the real composition ─────

test('demo: DARK BY DEFAULT — a booked conversation starts nothing until configuration enables the type', async () => {
  const { app } = composedApp();
  await bookSession(app);
  assert.deepEqual(await app.workflow.store.listInstances(), [], 'no instance for an unconfigured organization');
});

test('demo: end to end — real event, real one-shot timeout, real notification intent, terminal state', async () => {
  const { app, clock, configService, lines } = composedApp();
  configService.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: [DEMO_WORKFLOW_TYPE] });

  // A REAL durable event starts the instance.
  const session = await bookSession(app);
  const [instance] = await app.workflow.store.listInstances();
  assert.ok(instance, 'instance started from conversation.completed');
  assert.equal(instance.state, 'awaiting-follow-up');
  assert.equal(instance.instanceKey, session.sessionId);
  assert.deepEqual(instance.stateData, { sessionId: session.sessionId }, 'identifiers only — no caller data');
  assert.ok(lines.some((l) => l.event === 'guideherd.workflow.instance_started'));

  // A REAL one-shot scheduled action carries the timeout (structural key).
  const action = await app.scheduler.store.get(`workflow-timeout:${instance.instanceId}:follow-up`);
  assert.ok(action, 'timeout scheduled through the existing scheduler');
  assert.equal(action.runAtMs, T0 + HOUR_MS);

  // Time passes; the scheduler fires; the transition is deterministic.
  clock.set(T0 + HOUR_MS + 1);
  await app.scheduler.drain();
  const after = await app.workflow.store.get(instance.instanceId);
  assert.equal(after.state, 'completed', 'terminal state reached');
  assert.equal(after.completedAtMs, T0 + HOUR_MS + 1);
  assert.ok(lines.some((l) => l.event === 'guideherd.workflow.transitioned'));
  assert.ok(lines.some((l) => l.event === 'guideherd.workflow.completed'));

  // A REAL notification intent went through the Notification Contract:
  // the delivery claim machine holds the record (mail is unconfigured in
  // this composition, so the controlled result is 'not-configured' —
  // proving the full pipeline claim → provider boundary → record).
  const delivery = await app.notifications.deliveryStore.get(
    `appointment-reminder:${session.sessionId}:${DEMO_WORKFLOW_TYPE}`);
  assert.ok(delivery, 'the notification intent reached the Notification Contract');
  assert.equal(delivery.status, 'not-configured');

  // No customer data anywhere in workflow state or telemetry.
  const serialized = JSON.stringify(await app.workflow.store.listInstances()) + JSON.stringify(lines);
  assert.ok(!serialized.includes('caller@example.com'), 'caller details never enter workflow state or telemetry');
});

test('demo: duplicate-signal safety — replayed events and timeouts change nothing and duplicate nothing', async () => {
  const { app, clock, configService } = composedApp();
  configService.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: [DEMO_WORKFLOW_TYPE] });
  const session = await bookSession(app);
  const [instance] = await app.workflow.store.listInstances();

  // A duplicate outcome report is idempotent at the store, so no second
  // event exists; simulate at-least-once CONSUMER redelivery by applying
  // an event signal with a durable id through the engine's own seam.
  await app.workflow.applySignal(instance.instanceId,
    { kind: 'event', name: 'conversation.completed', event: { id: 'evt-replay' } });
  assert.equal((await app.workflow.store.listInstances()).length, 1, 'one instance, ever');

  clock.set(T0 + HOUR_MS + 1);
  await app.scheduler.drain();
  const first = await app.workflow.store.get(instance.instanceId);
  assert.equal(first.state, 'completed');

  // The SAME timeout signal again (scheduler retry / stale re-claim): the
  // DURABLE signal identity refuses it before any state reasoning — the
  // idempotent no-op, provable even across restarts and instances.
  const replay = await app.workflow.applySignal(instance.instanceId, { kind: 'timeout', name: 'follow-up' });
  assert.deepEqual(replay, { applied: false, reason: 'duplicate-signal' });

  // And the notification claim suppressed any duplicate customer effect.
  const delivery = await app.notifications.deliveryStore.get(
    `appointment-reminder:${session.sessionId}:${DEMO_WORKFLOW_TYPE}`);
  assert.equal(delivery.status, 'not-configured', 'exactly one recorded delivery attempt');
});

test('demo: enabling later never starts instances for historical events', async () => {
  const { app, configService } = composedApp();
  await bookSession(app); // processed while dark — the event settles
  configService.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: [DEMO_WORKFLOW_TYPE] });
  await app.outbox.drain(); // nothing pending: the event was settled dark
  assert.deepEqual(await app.workflow.store.listInstances(), [], 'no backfill from settled events');
});

// ── Definition versioning (ADR-0021) ────────────────────────────────────────

test('versioning: registration never redirects new instances — only explicit activation does; V1 instances stay V1', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const scheduled = [];
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} },
    scheduler: { register: () => {}, schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    clock,
  });
  const { registerStandardIntentExecutors } = require('./executors');
  registerStandardIntentExecutors({
    engine, scheduler: { schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    notificationService: { send: async () => ({ status: 'sent' }) },
    handoffStore: { get: async () => undefined }, integrationService: null, clock,
  });

  // V1 registered AND explicitly activated; an instance is bound to V1.
  engine.register(createDemoWorkflowDefinition({ version: 1, followUpDelayMs: HOUR_MS }));
  engine.activate(DEMO_WORKFLOW_TYPE, 1);
  const { instance: v1 } = await store.createInstance({
    instanceId: 'wf-v1', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1,
    instanceKey: 'sess-v1', organizationKey: FIRM, relatedEntityId: 'sess-v1',
    state: 'awaiting-follow-up', stateData: { sessionId: 'sess-v1' },
  });

  // V2 deploys concurrently (migration window): registered alongside V1.
  // V2 deliberately behaves differently so silent adoption would be visible.
  const v2def = createDemoWorkflowDefinition({ version: 2, followUpDelayMs: 2 * HOUR_MS });
  v2def.transition = () => null; // V2 does NOT complete on the follow-up timeout
  engine.register(v2def);
  assert.deepEqual(engine.registry.versions(DEMO_WORKFLOW_TYPE), [1, 2], 'both versions registered concurrently');

  // REGISTRATION REDIRECTS NOTHING: V1 remains the active start version.
  assert.equal(engine.registry.startDefinition(DEMO_WORKFLOW_TYPE).version, 1,
    'registering V2 does not touch the active selection');
  assert.equal(engine.registry.activeVersion(DEMO_WORKFLOW_TYPE), 1);

  // The V1 instance's signal resolves V1 EXACTLY: it still completes.
  const applied = await engine.applySignal(v1.instanceId, { kind: 'timeout', name: 'follow-up' });
  assert.equal(applied.applied, true, 'V1 semantics governed the V1 instance');
  assert.equal((await store.get(v1.instanceId)).state, 'completed');
  assert.equal((await store.get(v1.instanceId)).definitionVersion, 1, 'binding never changes');

  // Explicit ACTIVATION — the deliberate operation — moves NEW instances
  // (and only new instances) to V2.
  engine.activate(DEMO_WORKFLOW_TYPE, 2);
  assert.equal(engine.registry.startDefinition(DEMO_WORKFLOW_TYPE).version, 2);
  assert.equal((await store.get(v1.instanceId)).definitionVersion, 1,
    'existing instances remain on their persisted version');

  // Activating an UNREGISTERED version fails loudly — composition refuses.
  assert.throws(() => engine.activate(DEMO_WORKFLOW_TYPE, 7),
    (e) => e.code === 'workflow_definition_unavailable' && /@7/.test(e.message));
  assert.throws(() => engine.activate('never-registered', 1),
    (e) => e.code === 'workflow_definition_unavailable');
});

test('versioning: a version removed while instances still reference it fails LOUDLY — never silent latest-adoption', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} }, scheduler: { register: () => {}, schedule: async () => {} }, clock,
  });
  // Only V2 is registered — a deploy dropped V1 while an instance references it.
  engine.register(createDemoWorkflowDefinition({ version: 2 }));
  const { instance } = await store.createInstance({
    instanceId: 'wf-orphan', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1,
    instanceKey: 'sess-orphan', organizationKey: FIRM, relatedEntityId: null,
    state: 'awaiting-follow-up', stateData: {},
  });
  await assert.rejects(() => engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'follow-up' }),
    (e) => e.code === 'workflow_definition_unavailable' && /demo-follow-up@1/.test(e.message));
  assert.equal((await store.get(instance.instanceId)).state, 'awaiting-follow-up', 'the instance is untouched');
});

test('registry: duplicate (type, version) refused; version identity is strict', () => {
  const registry = createWorkflowDefinitionRegistry();
  registry.register(createDemoWorkflowDefinition({ version: 1 }));
  registry.register(createDemoWorkflowDefinition({ version: 2 }));
  assert.throws(() => registry.register(createDemoWorkflowDefinition({ version: 2 })), /already registered.*@2/);
  assert.throws(() => registry.register(createDemoWorkflowDefinition({ version: 1.5 })), /positive integer/);
  assert.equal(registry.resolve(DEMO_WORKFLOW_TYPE, 1).version, 1, 'exact resolution');
  assert.throws(() => registry.resolve(DEMO_WORKFLOW_TYPE, 3), (e) => e.code === 'workflow_definition_unavailable');
});

// ── Durable signal deduplication (ADR-0021) ─────────────────────────────────

test('signals: a re-entered state cannot be re-fired by a replayed signal — the durable identity refuses it', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} }, scheduler: { register: () => {}, schedule: async () => {} }, clock,
  });
  // A LOOPING definition: A -> B on timeout t1; B -> A on an event. A
  // state-only CAS would wrongly accept the replayed t1 once the instance
  // is back in A; the durable signal log is what makes replay safe.
  engine.register({
    workflowType: 'loop-demo', version: 1,
    startsOn: { eventType: 'never', instanceKeyOf: () => 'x' },
    start: () => ({ state: 'a' }),
    transition(state, signal) {
      if (state === 'a' && signal.kind === 'timeout' && signal.name === 't1') return { nextState: 'b' };
      if (state === 'b' && signal.kind === 'event') return { nextState: 'a' };
      return null;
    },
    terminalStates: ['done'],
  });
  const { instance } = await store.createInstance({
    instanceId: 'wf-loop', workflowType: 'loop-demo', definitionVersion: 1,
    instanceKey: 'x', organizationKey: FIRM, relatedEntityId: null, state: 'a', stateData: {},
  });

  assert.equal((await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 't1' })).applied, true);
  assert.equal((await store.get(instance.instanceId)).state, 'b');
  assert.equal((await engine.applySignal(instance.instanceId,
    { kind: 'event', name: 'evt', event: { id: 'evt-9' } })).applied, true);
  assert.equal((await store.get(instance.instanceId)).state, 'a', 'the instance looped back to a');

  // The replayed timeout: same durable identity — refused, though the
  // state alone would transition again.
  const replay = await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 't1' });
  assert.deepEqual(replay, { applied: false, reason: 'duplicate-signal' });
  assert.equal((await store.get(instance.instanceId)).state, 'a');
});

test('signals: a duplicate outbox-derived event (same durable event id) starts nothing and duplicates nothing', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const scheduled = [];
  let consumer;
  const engine = createWorkflowEngine({
    store,
    outbox: { register: (r) => { consumer = r; } },
    scheduler: { register: () => {}, schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    configService: (() => { const c = configServiceWithFirm();
      c.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: [DEMO_WORKFLOW_TYPE] }); return c; })(),
    clock,
  });
  const { registerStandardIntentExecutors } = require('./executors');
  registerStandardIntentExecutors({
    engine, scheduler: { schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    notificationService: { send: async () => ({ status: 'sent' }) },
    handoffStore: { get: async () => undefined }, integrationService: null, clock,
  });
  engine.register(createDemoWorkflowDefinition({ version: 1 }));
  engine.activate(DEMO_WORKFLOW_TYPE, 1);
  engine.attach();

  const event = { id: 'evt-42', type: 'conversation.completed', organizationKey: FIRM,
    sessionId: 'sess-dup', correlationId: 'gh-dup', payload: { status: 'booked' } };
  await consumer.handle(event);   // first delivery
  await consumer.handle(event);   // at-least-once redelivery, same durable id
  assert.equal((await store.listInstances()).length, 1, 'one instance');
  assert.equal(scheduled.length, 1, 'one timeout — the start intents did not duplicate');
});

test('signals: a crash between instance creation and intent recording is healed exactly-once by redelivery', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const scheduled = [];
  let consumer;
  const engine = createWorkflowEngine({
    store,
    outbox: { register: (r) => { consumer = r; } },
    scheduler: { register: () => {}, schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    configService: (() => { const c = configServiceWithFirm();
      c.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: [DEMO_WORKFLOW_TYPE] }); return c; })(),
    clock,
  });
  const { registerStandardIntentExecutors } = require('./executors');
  registerStandardIntentExecutors({
    engine, scheduler: { schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    notificationService: { send: async () => ({ status: 'sent' }) },
    handoffStore: { get: async () => undefined }, integrationService: null, clock,
  });
  engine.register(createDemoWorkflowDefinition({ version: 1 }));
  engine.activate(DEMO_WORKFLOW_TYPE, 1);
  engine.attach();

  // Simulated crash: the instance was created but the process died before
  // the initial intents were recorded (no signal accepted yet).
  await store.createInstance({
    instanceId: 'wf-crash', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1,
    instanceKey: 'sess-crash', organizationKey: FIRM, relatedEntityId: 'sess-crash',
    state: 'awaiting-follow-up', stateData: { sessionId: 'sess-crash' },
  });
  const event = { id: 'evt-crash', type: 'conversation.completed', organizationKey: FIRM,
    sessionId: 'sess-crash', correlationId: 'gh-crash', payload: { status: 'booked' } };
  await consumer.handle(event); // at-least-once redelivery heals the intents
  assert.equal(scheduled.length, 1, 'the lost initial intent was recovered');
  await consumer.handle(event); // and a further redelivery is a no-op
  assert.equal(scheduled.length, 1, 'exactly once');
});

test('signals: an IGNORED signal is consumed — replayed after the state becomes actionable, it stays inert (engine)', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} }, scheduler: { register: () => {}, schedule: async () => {} }, clock,
  });
  // In state A the event is IGNORED; in state B it WOULD transition to C.
  engine.register({
    workflowType: 'ignore-demo', version: 1,
    startsOn: { eventType: 'never', instanceKeyOf: () => 'x' },
    start: () => ({ state: 'a' }),
    transition(state, signal) {
      if (state === 'a' && signal.kind === 'timeout' && signal.name === 'advance') return { nextState: 'b' };
      if (state === 'b' && signal.kind === 'event' && signal.name === 'doc.received') return { nextState: 'c' };
      return null;
    },
    terminalStates: ['c'],
  });
  const { instance } = await store.createInstance({
    instanceId: 'wf-ign', workflowType: 'ignore-demo', definitionVersion: 1,
    instanceKey: 'x', organizationKey: FIRM, relatedEntityId: null, state: 'a', stateData: {},
  });

  // 1. X delivered in state A: structurally valid, no transition — CONSUMED.
  const first = await engine.applySignal(instance.instanceId,
    { kind: 'event', name: 'doc.received', event: { id: 'X' } });
  assert.deepEqual(first, { applied: false, reason: 'ignored' });
  assert.equal((await store.get(instance.instanceId)).state, 'a', 'no state change');
  assert.deepEqual(await store.getSignal(instance.instanceId, 'event:X'),
    { signalId: 'event:X', outcome: 'ignored' }, 'identity + outcome recorded durably');

  // 2. The instance moves to B, where X WOULD be actionable.
  await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'advance' });
  assert.equal((await store.get(instance.instanceId)).state, 'b');

  // 3–4. Replay X: refused forever — stale history is not a new action.
  const replay = await engine.applySignal(instance.instanceId,
    { kind: 'event', name: 'doc.received', event: { id: 'X' } });
  assert.deepEqual(replay, { applied: false, reason: 'duplicate-signal' });
  assert.equal((await store.get(instance.instanceId)).state, 'b');

  // A FRESH delivery (new identity) in state B transitions normally.
  const fresh = await engine.applySignal(instance.instanceId,
    { kind: 'event', name: 'doc.received', event: { id: 'X2' } });
  assert.equal(fresh.applied, true);
  assert.equal((await store.get(instance.instanceId)).state, 'c');
});

test('signals: a duplicate IGNORED timeout and a duplicate IGNORED outbox-derived signal are both consumed exactly once', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  let consumer;
  const engine = createWorkflowEngine({
    store,
    outbox: { register: (r) => { consumer = r; } },
    scheduler: { register: () => {}, schedule: async () => {} },
    configService: (() => { const c = configServiceWithFirm();
      c.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: ['quiet-demo'] }); return c; })(),
    clock,
  });
  // A definition that reacts to an event type mid-flight but IGNORES it in
  // its current state, and has no timeout transitions at all.
  engine.register({
    workflowType: 'quiet-demo', version: 1,
    startsOn: { eventType: 'conversation.completed', instanceKeyOf: (e) => e.sessionId },
    reactsTo: { 'conversation.connected': (e) => e.sessionId },
    start: () => ({ state: 'waiting' }),
    transition: () => null, // ignores everything
    terminalStates: ['done'],
  });
  engine.activate('quiet-demo', 1);
  engine.attach();
  await consumer.handle({ id: 'evt-start', type: 'conversation.completed', organizationKey: FIRM,
    sessionId: 'sess-q', correlationId: 'gh-q', payload: { status: 'booked' } });
  const [instance] = await store.listInstances();

  // Duplicate IGNORED timeout: consumed once, duplicate forever after.
  const t1 = await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'ghost' });
  assert.deepEqual(t1, { applied: false, reason: 'ignored' });
  const t2 = await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'ghost' });
  assert.deepEqual(t2, { applied: false, reason: 'duplicate-signal' });

  // Duplicate IGNORED outbox-derived signal, through the real consumer seam.
  const evt = { id: 'evt-mid', type: 'conversation.connected', organizationKey: FIRM,
    sessionId: 'sess-q', correlationId: 'gh-q', payload: {} };
  await consumer.handle(evt);
  assert.deepEqual(await store.getSignal(instance.instanceId, 'event:evt-mid'),
    { signalId: 'event:evt-mid', outcome: 'ignored' });
  await consumer.handle(evt); // redelivery: already consumed, still inert
  assert.equal((await store.get(instance.instanceId)).state, 'waiting');
  assert.equal((await store.listInstances()).length, 1);
});

// ── Step reliability ────────────────────────────────────────────────────────

test('engine: a failing step retries with bounded attempts, then abandons loudly', async () => {
  const { createWorkflowEngine } = require('./engine');
  const { createTelemetry } = require('../telemetry/telemetry');
  const clock = fixedClock(T0);
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock });
  const store = createInMemoryWorkflowStore({ clock });
  const engine = createWorkflowEngine({
    store,
    outbox: { register: () => {} },
    scheduler: { register: () => {}, schedule: async () => {} },
    clock,
    telemetry,
    maxStepAttempts: 3,
  });
  engine.register(createDemoWorkflowDefinition());
  engine.registerIntentExecutor('notify', async () => { throw new Error('synthetic executor failure'); });
  engine.registerIntentExecutor('schedule-timeout', async () => {});

  const { instance } = await store.createInstance({
    instanceId: 'wf-1', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1, instanceKey: 'sess-r', organizationKey: FIRM,
    relatedEntityId: 'sess-r', state: 'awaiting-follow-up', stateData: { sessionId: 'sess-r' },
  });
  await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'follow-up' });

  // Attempt 1 happened inline; two more drains reach the bound of 3.
  await engine.drain();
  await engine.drain();
  const failures = lines.filter((l) => l.event === 'guideherd.workflow.step_failed');
  const abandoned = lines.filter((l) => l.event === 'guideherd.workflow.step_abandoned');
  assert.equal(failures.length, 2, 'bounded retries below the cap');
  assert.equal(abandoned.length, 1, 'abandoned exactly at the cap');
  assert.equal((await store.getStep(`${instance.instanceId}:awaiting-follow-up->completed:0`)).status, 'abandoned');
  // The instance still reached its state — step failure never corrupts state.
  assert.equal((await store.get(instance.instanceId)).state, 'completed');
});

test('engine: an unregistered intent executor fails the step loudly, never silently', async () => {
  const { createWorkflowEngine } = require('./engine');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} }, scheduler: { register: () => {}, schedule: async () => {} },
    clock, maxStepAttempts: 1,
  });
  engine.register(createDemoWorkflowDefinition());
  const { instance } = await store.createInstance({
    instanceId: 'wf-2', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1, instanceKey: 'sess-u', organizationKey: FIRM,
    relatedEntityId: 'sess-u', state: 'awaiting-follow-up', stateData: { sessionId: 'sess-u' },
  });
  await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'follow-up' });
  assert.equal((await store.getStep(`${instance.instanceId}:awaiting-follow-up->completed:0`)).status, 'abandoned');
});

// ── Semantic independence from the Integration Contract ─────────────────────

test('independence: the engine and the demonstration workflow are fully functional with NO integration service', async () => {
  const { createWorkflowEngine } = require('./engine');
  const { registerStandardIntentExecutors } = require('./executors');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const scheduled = [];
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} },
    scheduler: { register: () => {}, schedule: async (a) => { scheduled.push(a); } },
    clock,
  });
  engine.register(createDemoWorkflowDefinition());
  registerStandardIntentExecutors({
    engine,
    scheduler: { schedule: async (a) => { scheduled.push(a); } },
    notificationService: { send: async () => ({ status: 'sent' }) },
    handoffStore: { get: async () => undefined },
    integrationService: null, // ← no Integration Contract composed
    clock,
  });
  assert.deepEqual(engine.executorNames().sort(), ['notify', 'schedule-timeout'],
    'the integrate executor exists only when the Integration Contract is composed');

  const { instance } = await store.createInstance({
    instanceId: 'wf-3', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1, instanceKey: 'sess-i', organizationKey: FIRM,
    relatedEntityId: 'sess-i', state: 'awaiting-follow-up', stateData: { sessionId: 'sess-i' },
  });
  const applied = await engine.applySignal(instance.instanceId, { kind: 'timeout', name: 'follow-up' });
  assert.equal(applied.applied, true, 'the demonstration workflow never states an integration intent');
  assert.equal((await store.get(instance.instanceId)).state, 'completed');
});

// ── Executors ───────────────────────────────────────────────────────────────

test('executors: schedule-timeout dedupes by actionKey; notify re-reads business truth and settles gracefully', async () => {
  const { createWorkflowEngine } = require('./engine');
  const { registerStandardIntentExecutors } = require('./executors');
  const clock = fixedClock(T0);
  const store = createInMemoryWorkflowStore({ clock });
  const scheduled = [];
  const sent = [];
  const engine = createWorkflowEngine({
    store, outbox: { register: () => {} }, scheduler: { register: () => {} }, clock,
  });
  registerStandardIntentExecutors({
    engine,
    scheduler: { schedule: async (a) => { scheduled.push(a); return { scheduled: true, action: a }; } },
    notificationService: { send: async (r) => { sent.push(r); return { status: 'sent' }; } },
    handoffStore: { get: async () => undefined }, // session gone: notify settles
    integrationService: { request: async () => ({ status: 'completed' }) },
    clock,
  });
  assert.ok(engine.executorNames().includes('integrate'), 'integrate rides along when composed');

  // Timeout intents derive a structural actionKey from the instance.
  const timeoutExec = async () => {
    const { instance } = await store.createInstance({
      instanceId: 'wf-4', workflowType: DEMO_WORKFLOW_TYPE, definitionVersion: 1, instanceKey: 'k', organizationKey: FIRM,
      relatedEntityId: null, state: 'awaiting-follow-up', stateData: {},
    });
    await store.transition(instance.instanceId, 'awaiting-follow-up', {
      toState: 'awaiting-follow-up', stateData: {},
      steps: [{ stepKey: 'wf-4:start->s:0', instanceId: 'wf-4', organizationKey: FIRM, intent: { intent: 'schedule-timeout', name: 'follow-up', delayMs: 1000 } }],
    });
    await engine.drain();
  };
  await timeoutExec();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].actionKey, 'workflow-timeout:wf-4:follow-up');
  assert.equal(scheduled[0].runAtMs, T0 + 1000);

  // Notify with no session: business truth re-read found nothing — the
  // step settles without a notification and without an error.
  await store.transition('wf-4', 'awaiting-follow-up', {
    toState: 'awaiting-follow-up', stateData: {},
    steps: [{ stepKey: 'wf-4:s->s:1', instanceId: 'wf-4', organizationKey: FIRM, intent: { intent: 'notify', notificationType: 'appointment-reminder', sessionId: 'gone', qualifier: 'q' } }],
  });
  await engine.drain();
  assert.equal(sent.length, 0);
  assert.equal((await store.getStep('wf-4:s->s:1')).status, 'completed');
});

// ── Configuration domain ────────────────────────────────────────────────────

test('domain: workflows enablement is dark by default, fail-safe on reads, strict on writes', () => {
  const configService = configServiceWithFirm();
  assert.deepEqual(readDomain(configService, 'workflows', FIRM).value, { enabledTypes: [] });

  configService.settings.set(FIRM, 'workflow', 'enabled-types', { enabledTypes: 'nonsense' });
  const damaged = readDomain(configService, 'workflows', FIRM);
  assert.deepEqual(damaged.value, { enabledTypes: [] }, 'damage degrades to dark');
  assert.ok(damaged.issues.length > 0);

  assert.equal(validateDomain('workflows', { enabledTypes: [DEMO_WORKFLOW_TYPE], extra: 1 }, {}).ok, false);
  assert.equal(validateDomain('workflows', { enabledTypes: ['client-intake'] },
    { workflowTypes: [DEMO_WORKFLOW_TYPE] }).ok, false, 'unknown types refused when the registry context is supplied');
  assert.equal(validateDomain('workflows', { enabledTypes: [DEMO_WORKFLOW_TYPE] },
    { workflowTypes: [DEMO_WORKFLOW_TYPE] }).ok, true);
  assert.equal(validateDomain('workflows', { enabledTypes: [] }, {}).ok, true, 'returning to dark is always valid');
});

// ── Composition ─────────────────────────────────────────────────────────────

test('composition: createApp exposes the engine, registers the demo definition, and reports the capability', async () => {
  const { app } = composedApp();
  assert.deepEqual(app.workflow.registry.types(), [DEMO_WORKFLOW_TYPE]);
  assert.deepEqual(app.workflow.registry.versions(DEMO_WORKFLOW_TYPE), [1]);
  assert.deepEqual(app.workflow.executorNames().sort(), ['integrate', 'notify', 'schedule-timeout']);
  const health = await app.operations.health();
  assert.equal(health.find((h) => h.capability === 'workflow-engine').status, 'available');
  // Sibling contracts remain composed and unaware.
  assert.ok(app.outbox && app.scheduler && app.notifications.service && app.integrations.service);
});
