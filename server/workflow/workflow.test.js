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
  // event exists; simulate at-least-once CONSUMER redelivery by handling
  // the same logical event again through the engine's own seam.
  await app.workflow.applySignal(instance.instanceId, { kind: 'event', name: 'conversation.completed' });
  assert.equal((await app.workflow.store.listInstances()).length, 1, 'one instance, ever');

  clock.set(T0 + HOUR_MS + 1);
  await app.scheduler.drain();
  const first = await app.workflow.store.get(instance.instanceId);
  assert.equal(first.state, 'completed');

  // The SAME timeout signal again (scheduler retry / stale re-claim):
  // (terminal state, signal) has no transition — the idempotent no-op.
  const replay = await app.workflow.applySignal(instance.instanceId, { kind: 'timeout', name: 'follow-up' });
  assert.deepEqual(replay, { applied: false, reason: 'terminal' });

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
    instanceId: 'wf-1', workflowType: DEMO_WORKFLOW_TYPE, instanceKey: 'sess-r', organizationKey: FIRM,
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
    instanceId: 'wf-2', workflowType: DEMO_WORKFLOW_TYPE, instanceKey: 'sess-u', organizationKey: FIRM,
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
    instanceId: 'wf-3', workflowType: DEMO_WORKFLOW_TYPE, instanceKey: 'sess-i', organizationKey: FIRM,
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
      instanceId: 'wf-4', workflowType: DEMO_WORKFLOW_TYPE, instanceKey: 'k', organizationKey: FIRM,
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
  assert.deepEqual(app.workflow.executorNames().sort(), ['integrate', 'notify', 'schedule-timeout']);
  const health = await app.operations.health();
  assert.equal(health.find((h) => h.capability === 'workflow-engine').status, 'available');
  // Sibling contracts remain composed and unaware.
  assert.ok(app.outbox && app.scheduler && app.notifications.service && app.integrations.service);
});
