'use strict';

/**
 * GuideHerd Scheduler Contract tests (ADR-0018).
 *
 * Unit tests drive the scheduled-action store and processor against the
 * in-memory reference (PostgreSQL legs live in operational.test.js);
 * workflow tests prove appointment reminders end to end — scheduling
 * from the durable event, execution through the Notification Contract,
 * duplicate suppression, recovery, expiry, and Operations visibility.
 * Deterministic: fixed clocks, no timers awaited, no providers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createInMemoryHandoffStore } = require('../handoff/store');
const { createTelemetry } = require('../telemetry/telemetry');
const { makeSession, BOOKED_OUTCOME } = require('../operational/contract-suite');
const { createOutbox, createInMemoryOutboxStore } = require('../outbox/outbox');
const { createNotificationProviderRegistry } = require('../notifications/contract');
const { createInMemoryNotificationDeliveryStore } = require('../notifications/delivery-store');
const { createNotificationService } = require('../notifications/service');
const { validateDomain } = require('../configuration/framework');
const {
  createScheduler, createInMemoryScheduledActionStore, validateScheduledAction,
  SCHEDULER_STALE_PROCESSING_MS, DEFAULT_MAX_ATTEMPTS,
} = require('./scheduler');
const { registerAppointmentReminders, reminderKey, REMINDERS_DOMAIN } = require('./reminders');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const APPT_MS = Date.parse(BOOKED_OUTCOME.appointment.startsAt); // 2026-07-20T20:00:00Z
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

// ── The scheduled-action store and processor (memory reference) ─────────────

function makeRig({ maxAttempts = 3 } = {}) {
  const clock = fixedClock(T0);
  const store = createInMemoryScheduledActionStore({ clock });
  const emitted = [];
  const tel = createTelemetry({ log: (l) => emitted.push(JSON.parse(l)), clock });
  const scheduler = createScheduler({ store, clock, telemetry: tel, maxAttempts, backoffMs: [1000, 5000] });
  return { clock, store, scheduler, emitted };
}

test('scheduler: actions validate; scheduling is structurally deduplicated by actionKey', async () => {
  const { scheduler, store } = makeRig();
  assert.throws(() => validateScheduledAction({ actionType: 't', organizationKey: 'o', runAtMs: 1 }), TypeError);
  assert.throws(() => validateScheduledAction({ actionKey: 'k', actionType: 't', organizationKey: 'o', runAtMs: NaN }), TypeError);

  const action = { actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 + 1000 };
  assert.equal((await scheduler.schedule(action)).scheduled, true);
  assert.equal((await scheduler.schedule(action)).scheduled, false, 'same key never schedules twice');
  assert.equal(await store.size(), 1);
});

test('scheduler: never executes early; a due action presents as ready, executes exactly once at its UTC time', async () => {
  const { clock, scheduler, store } = makeRig();
  const ran = [];
  scheduler.register({ actionType: 't', handle: async (a) => { ran.push(a.actionKey); } });
  await scheduler.schedule({ actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 + 60_000 });

  await scheduler.drain();
  assert.deepEqual(ran, [], 'not due: never executes before runAt');
  assert.equal((await store.get('k:1')).presentedState, 'pending');

  clock.advance(60_000);
  assert.equal((await store.get('k:1')).presentedState, 'ready', 'due and unclaimed presents as ready');
  await scheduler.drain();
  assert.deepEqual(ran, ['k:1']);
  assert.equal((await store.get('k:1')).state, 'completed');
  await scheduler.drain();
  await scheduler.drain();
  assert.deepEqual(ran, ['k:1'], 'completed never re-executes');
});

test('scheduler: bounded retries with deterministic backoff; exhaustion is terminal failed with retry metadata', async () => {
  const { clock, scheduler, store } = makeRig({ maxAttempts: 3 });
  let attempts = 0;
  scheduler.register({ actionType: 't', handle: async () => { attempts += 1; throw new Error('down'); } });
  await scheduler.schedule({ actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 });

  await scheduler.drain();
  assert.equal(attempts, 1);
  const afterFirst = await store.get('k:1');
  assert.equal(afterFirst.state, 'failed');
  assert.equal(afterFirst.attempts, 1);
  assert.equal(afterFirst.nextAttemptAtMs, T0 + 1000, 'retry metadata records the next attempt');

  await scheduler.drain();
  assert.equal(attempts, 1, 'backoff holds');
  clock.advance(1000);
  await scheduler.drain();
  assert.equal(attempts, 2);
  clock.advance(5000);
  await scheduler.drain();
  assert.equal(attempts, 3, 'final attempt');
  const exhausted = await store.get('k:1');
  assert.equal(exhausted.state, 'failed');
  assert.equal(exhausted.nextAttemptAtMs, null, 'exhaustion is terminal');
  clock.advance(60_000);
  await scheduler.drain();
  assert.equal(attempts, 3, 'terminal failed never retries');
});

test('scheduler: a stale processing claim (crashed executor) re-claims; a fresh claim is honored', async () => {
  const { clock, scheduler, store } = makeRig();
  const ran = [];
  scheduler.register({ actionType: 't', handle: async (a) => { ran.push(a.actionKey); } });
  await scheduler.schedule({ actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 });
  await store.claim('k:1', { maxAttempts: 3 }); // executor claims, then dies

  await scheduler.drain();
  assert.deepEqual(ran, [], 'fresh processing claim blocks concurrent execution');
  clock.advance(SCHEDULER_STALE_PROCESSING_MS);
  await scheduler.drain();
  assert.deepEqual(ran, ['k:1'], 'stale claim re-claimed: at-least-once execution');
});

test('scheduler: cancellation withdraws pending work; terminal states are final', async () => {
  const { clock, scheduler, store } = makeRig();
  const ran = [];
  scheduler.register({ actionType: 't', handle: async (a) => { ran.push(a.actionKey); } });
  await scheduler.schedule({ actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 + 1000 });

  assert.equal((await scheduler.cancel('k:1')).cancelled, true);
  clock.advance(5000);
  await scheduler.drain();
  assert.deepEqual(ran, [], 'cancelled work never executes');
  assert.equal((await store.get('k:1')).state, 'cancelled');
  assert.equal((await scheduler.cancel('k:1')).cancelled, false, 'terminal states stay');
});

test('scheduler: an action past its expiry never executes — it expires, with telemetry', async () => {
  const { clock, scheduler, store, emitted } = makeRig();
  const ran = [];
  scheduler.register({ actionType: 't', handle: async (a) => { ran.push(a.actionKey); } });
  await scheduler.schedule({
    actionKey: 'k:1', actionType: 't', organizationKey: 'org-a',
    runAtMs: T0 + 1000, expiresAtMs: T0 + 2000,
  });

  clock.advance(3000); // past runAt AND past expiry without any drain (downtime)
  await scheduler.drain();
  assert.deepEqual(ran, [], 'worthless work never executes late');
  assert.equal((await store.get('k:1')).state, 'expired');
  assert.equal(emitted.filter((l) => l.event === 'guideherd.scheduler.action_expired').length, 1);
});

test('scheduler: two instances over one store execute a due action exactly once', async () => {
  const clock = fixedClock(T0);
  const store = createInMemoryScheduledActionStore({ clock });
  let effects = 0;
  const instance = () => {
    const scheduler = createScheduler({ store, clock, maxAttempts: 3, backoffMs: [1000] });
    scheduler.register({ actionType: 't', handle: async () => { effects += 1; } });
    return scheduler;
  };
  const a = instance();
  const b = instance();
  await store.schedule({ actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 });

  await Promise.all([a.drain(), b.drain()]);
  assert.equal(effects, 1, 'the atomic claim admits exactly one executor');
  assert.equal((await store.get('k:1')).state, 'completed');
});

test('scheduler: restart recovery — a fresh processor over the same store executes what a dead one left', async () => {
  const clock = fixedClock(T0);
  const store = createInMemoryScheduledActionStore({ clock });
  await store.schedule({ actionKey: 'k:1', actionType: 't', organizationKey: 'org-a', runAtMs: T0 + 1000 });
  // the process that scheduled this dies here; a new instance boots later
  clock.advance(60_000);
  const ran = [];
  const revived = createScheduler({ store, clock });
  revived.register({ actionType: 't', handle: async (a) => { ran.push(a.actionKey); } });
  await revived.drain();
  assert.deepEqual(ran, ['k:1'], 'boot drain recovers scheduled work across restarts');
});

test('scheduler: registration is a programming contract; idle drains emit no telemetry', async () => {
  const { scheduler, emitted } = makeRig();
  scheduler.register({ actionType: 'a', handle: async () => {} });
  assert.throws(() => scheduler.register({ actionType: 'a', handle: async () => {} }), /already registered/);
  assert.throws(() => scheduler.register({ actionType: '' }), TypeError);
  assert.deepEqual(scheduler.handlerTypes(), ['a']);
  await scheduler.drain();
  await scheduler.drain();
  assert.deepEqual(emitted, [], 'an empty schedule drains in silence');
});

test('scheduler: the extension point — a future workflow is one action definition and one registration', async () => {
  const { clock, scheduler, emitted } = makeRig();
  // A future subsystem defines its action and registers its handler.
  // The scheduler core, the stores, and every other workflow are untouched.
  const followUps = [];
  scheduler.register({
    actionType: 'consultation-follow-up',
    handle: async (action) => { followUps.push(action.payload.formality); },
  });
  await scheduler.schedule({
    actionKey: 'consultation-follow-up:s-9',
    actionType: 'consultation-follow-up',
    organizationKey: FIRM,
    sessionId: 's-9',
    runAtMs: T0 + 86_400_000, // the day after the consultation
    payload: { formality: 'warm' },
  });
  clock.advance(86_400_000);
  await scheduler.drain();
  assert.deepEqual(followUps, ['warm']);
  assert.equal(emitted.filter((l) => l.event === 'guideherd.scheduler.action_completed').length, 1);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 5);
});

// ── Appointment reminders: the first scheduled workflow ─────────────────────

function reminderRig({ enabled = true, offsets } = {}) {
  const clock = fixedClock(T0);
  const outboxStore = createInMemoryOutboxStore({ clock });
  const store = createInMemoryHandoffStore({ clock, outbox: outboxStore });
  const outbox = createOutbox({ store: outboxStore, clock });
  const schedulerStore = createInMemoryScheduledActionStore({ clock });
  const emitted = [];
  const tel = createTelemetry({ log: (l) => emitted.push(JSON.parse(l)), clock });
  const scheduler = createScheduler({ store: schedulerStore, clock, telemetry: tel, backoffMs: [1000] });

  const db = openDatabase();
  migrate(db, { clock });
  const configService = createConfigService({ db, clock });
  configService.organizations.create({ key: 'org-a', name: 'Org A', timezone: 'America/Chicago' });
  if (enabled) {
    configService.settings.set('org-a', 'scheduler', 'appointment-reminders',
      offsets ? { enabled: true, offsets } : { enabled: true });
  }

  const sent = [];
  const registry = createNotificationProviderRegistry();
  registry.register({
    providerKey: 'graph-email',
    async deliver(message, context) { sent.push({ key: context.notificationKey, message }); return { status: 'sent' }; },
  });
  const notificationService = createNotificationService({
    registry, deliveryStore: createInMemoryNotificationDeliveryStore({ clock }), telemetry: tel,
  });
  registerAppointmentReminders({ outbox, scheduler, store, notificationService, configService, clock });
  return { clock, store, outbox, scheduler, schedulerStore, configService, sent, emitted };
}

async function bookOnStore(store, outbox) {
  const { session } = makeSession();
  await store.create(session);
  await store.connectEligible('org-a', {}, { correlationId: 'gh-reminders111111111111111' });
  await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME }, { correlationId: 'gh-reminders111111111111111' });
  await outbox.drain();
  return session.sessionId;
}

test('reminders: a booked conversation schedules the configured slots at exact UTC times; duplicates never double-schedule', async () => {
  const { store, outbox, schedulerStore } = reminderRig();
  const sessionId = await bookOnStore(store, outbox);

  assert.equal(await schedulerStore.size(), 2, '24h and 1h reminders scheduled');
  const day = await schedulerStore.get(reminderKey(sessionId, '24h'));
  const hour = await schedulerStore.get(reminderKey(sessionId, '1h'));
  assert.equal(day.runAtMs, APPT_MS - 24 * 3_600_000, 'UTC math from the appointment instant');
  assert.equal(hour.runAtMs, APPT_MS - 3_600_000);
  assert.equal(day.expiresAtMs, APPT_MS, 'a reminder after the appointment must never send');
  assert.equal(day.state, 'pending');

  // Outbox redelivery / duplicate outcome reports: structurally inert.
  await outbox.drain();
  await outbox.drain();
  assert.equal(await schedulerStore.size(), 2, 'actionKey dedupe holds under replay');
});

test('reminders: DISABLED BY DEFAULT — without configuration, booked events settle and nothing schedules', async () => {
  const { store, outbox, schedulerStore, scheduler, clock, sent } = reminderRig({ enabled: false });
  await bookOnStore(store, outbox);
  assert.equal(await schedulerStore.size(), 0, 'production behavior preserved exactly');
  clock.advance(30 * 24 * 3_600_000);
  await scheduler.drain();
  assert.equal(sent.length, 0);
});

test('reminders: each slot delivers exactly once at its time through the Notification Contract', async () => {
  const { clock, store, outbox, scheduler, sent } = reminderRig();
  const sessionId = await bookOnStore(store, outbox);

  await scheduler.drain();
  assert.equal(sent.length, 0, 'nothing is due yet');

  clock.advance(APPT_MS - 24 * 3_600_000 - T0); // exactly the 24h mark
  await scheduler.drain();
  assert.deepEqual(sent.map((s) => s.key), [reminderKey(sessionId, '24h')]);
  await scheduler.drain();
  assert.equal(sent.length, 1, 'the 24h reminder never repeats');

  clock.advance(23 * 3_600_000); // the 1h mark
  await scheduler.drain();
  assert.deepEqual(sent.map((s) => s.key), [reminderKey(sessionId, '24h'), reminderKey(sessionId, '1h')]);
  assert.ok(sent[1].message.rendered.subject.length > 0, 'rendered through the notification templates');
});

test('reminders: cross-instance execution — two schedulers, one store, one reminder', async () => {
  const rig = reminderRig();
  const sessionId = await bookOnStore(rig.store, rig.outbox);
  // A second API instance: its own processor over the SAME stores.
  const second = createScheduler({ store: rig.schedulerStore, clock: rig.clock, backoffMs: [1000] });
  const registry = createNotificationProviderRegistry();
  registry.register({
    providerKey: 'graph-email',
    async deliver(message, context) { rig.sent.push({ key: context.notificationKey, message }); return { status: 'sent' }; },
  });
  // Instance B shares the DELIVERY store in production (PostgreSQL); the
  // action claim alone already admits one executor, which is what this
  // test isolates.
  registerAppointmentReminders({
    outbox: createOutbox({ store: createInMemoryOutboxStore({ clock: rig.clock }), clock: rig.clock }),
    scheduler: second, store: rig.store,
    notificationService: createNotificationService({
      registry, deliveryStore: createInMemoryNotificationDeliveryStore({ clock: rig.clock }),
    }),
    configService: rig.configService, clock: rig.clock,
  });

  rig.clock.advance(APPT_MS - 24 * 3_600_000 - T0);
  await Promise.all([rig.scheduler.drain(), second.drain()]);
  assert.equal(rig.sent.filter((s) => s.key === reminderKey(sessionId, '24h')).length, 1,
    'the atomic action claim admits exactly one instance');
});

test('reminders: delivery failure retries with backoff and succeeds without duplicating', async () => {
  const clock = fixedClock(T0);
  const outboxStore = createInMemoryOutboxStore({ clock });
  const store = createInMemoryHandoffStore({ clock, outbox: outboxStore });
  const outbox = createOutbox({ store: outboxStore, clock });
  const schedulerStore = createInMemoryScheduledActionStore({ clock });
  const scheduler = createScheduler({ store: schedulerStore, clock, backoffMs: [1000] });
  const db = openDatabase();
  migrate(db, { clock });
  const configService = createConfigService({ db, clock });
  configService.organizations.create({ key: 'org-a', name: 'Org A', timezone: 'America/Chicago' });
  configService.settings.set('org-a', 'scheduler', 'appointment-reminders', { enabled: true });

  const sent = [];
  let failures = 1;
  const registry = createNotificationProviderRegistry();
  registry.register({
    providerKey: 'graph-email',
    async deliver(message, context) {
      if (failures > 0) { failures -= 1; return { status: 'failed' }; }
      sent.push(context.notificationKey);
      return { status: 'sent' };
    },
  });
  registerAppointmentReminders({
    outbox, scheduler, store,
    notificationService: createNotificationService({
      registry, deliveryStore: createInMemoryNotificationDeliveryStore({ clock }),
    }),
    configService, clock,
  });
  const sessionId = await bookOnStore(store, outbox);

  clock.advance(APPT_MS - 3_600_000 - T0); // only the 1h slot still lies ahead… the 24h slot is due too
  await scheduler.drain();
  // Both slots due; the first delivery attempt failed for one of them.
  const failed = (await schedulerStore.listRecent({})).filter((a) => a.state === 'failed');
  assert.equal(failed.length, 1, 'a failed delivery marks the action failed for retry');
  clock.advance(1000);
  await scheduler.drain();
  assert.equal(sent.length, 2, 'the retry delivered; nothing duplicated');
  assert.deepEqual([...new Set(sent)].length, 2);
});

test('reminders: execution re-checks the present — disabling later stops scheduled reminders silently', async () => {
  const { clock, store, outbox, scheduler, schedulerStore, configService, sent } = reminderRig();
  const sessionId = await bookOnStore(store, outbox);
  configService.settings.set('org-a', 'scheduler', 'appointment-reminders', { enabled: false });

  clock.advance(APPT_MS - 3_600_000 - T0);
  await scheduler.drain();
  assert.equal(sent.length, 0, 'disabled at execution time: no send');
  assert.equal((await schedulerStore.get(reminderKey(sessionId, '24h'))).state, 'completed', 'the action settles');
});

test('reminders: booking inside a slot window skips that slot; unprocessed reminders expire at the appointment', async () => {
  const clock = fixedClock(APPT_MS - 2 * 3_600_000); // booked 2h before the appointment
  const outboxStore = createInMemoryOutboxStore({ clock });
  const store = createInMemoryHandoffStore({ clock, outbox: outboxStore });
  const outbox = createOutbox({ store: outboxStore, clock });
  const schedulerStore = createInMemoryScheduledActionStore({ clock });
  const scheduler = createScheduler({ store: schedulerStore, clock });
  const db = openDatabase();
  migrate(db, { clock });
  const configService = createConfigService({ db, clock });
  configService.organizations.create({ key: 'org-a', name: 'Org A', timezone: 'America/Chicago' });
  configService.settings.set('org-a', 'scheduler', 'appointment-reminders', { enabled: true });
  registerAppointmentReminders({
    outbox, scheduler, store,
    notificationService: { send: async () => ({ status: 'sent' }) },
    configService, clock,
  });

  const { session } = makeSession({ now: clock.now() });
  await store.create(session);
  await store.connectEligible('org-a', {}, {});
  await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME }, {});
  await outbox.drain();

  assert.equal(await schedulerStore.size(), 1, 'the 24h slot is already past: only 1h scheduled');
  assert.ok(await schedulerStore.get(reminderKey(session.sessionId, '1h')));

  // The instance goes down; nobody drains until AFTER the appointment.
  clock.advance(3 * 3_600_000);
  await scheduler.drain();
  assert.equal((await schedulerStore.get(reminderKey(session.sessionId, '1h'))).state, 'expired',
    'a reminder after the appointment never sends');
});

// ── Configuration: the appointment-reminders domain ─────────────────────────

test('reminders config: lenient reads default dark; the producer gate is strict', () => {
  assert.equal(validateDomain(REMINDERS_DOMAIN, { enabled: true }).ok, true);
  const custom = validateDomain(REMINDERS_DOMAIN, {
    enabled: true,
    offsets: [{ slot: '48h', minutesBefore: 2880 }, { slot: '2h', minutesBefore: 120 }],
  });
  assert.equal(custom.ok, true, 'additional intervals are one more entry');
  assert.deepEqual(custom.normalized.offsets.map((o) => o.slot), ['48h', '2h']);

  assert.equal(validateDomain(REMINDERS_DOMAIN, { enabled: 'yes' }).ok, false);
  assert.equal(validateDomain(REMINDERS_DOMAIN, { enabled: true, offsets: [] }).ok, false);
  assert.equal(validateDomain(REMINDERS_DOMAIN, {
    enabled: true, offsets: [{ slot: '1h', minutesBefore: 60 }, { slot: '1h', minutesBefore: 90 }],
  }).ok, false, 'duplicate slots rejected');
  assert.equal(validateDomain(REMINDERS_DOMAIN, {
    enabled: true, offsets: [{ slot: 'x', minutesBefore: 999_999 }],
  }).ok, false, 'bounded intervals');
});

// ── HTTP: the platform end to end, plus Operations visibility ───────────────

function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  const configService = createConfigService({ db, clock: fixedClock(T0) });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', displayOrder: 1 });
  return configService;
}

const DEV_USERS = JSON.stringify([
  { key: 'dev-key-ops-0123456789abcdef', subject: 'op-sam', displayName: 'Sam Ops', organizationKey: FIRM, roles: ['operator'] },
]);

test('HTTP: booked → scheduled → due → reminder delivered exactly once; Operations shows the whole story', async () => {
  const clock = fixedClock(T0);
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'scheduler', 'appointment-reminders', { enabled: true });
  const app = createApp({
    demoBridgeSecret: SECRET, clock,
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    configService, devUsersJson: DEV_USERS,
  });
  const sent = [];
  app.notifications.registry.register({
    providerKey: 'capture',
    async deliver(message, context) { sent.push(context.notificationKey); return { status: 'sent' }; },
  });
  configService.settings.set(FIRM, 'notifications', 'provider', { provider: 'capture' });

  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    const created = await (await post('/api/v1/handoffs', {
      firmId: FIRM,
      caller: { fullName: 'Reminder Caller', email: 'reminder@example.com', phone: '+12565550188' },
      scheduling: { consultationTypeId: 'initial-consultation' },
      handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
    })).json();
    await post('/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
    await post('/api/v1/demo/outcome', {
      sessionId: created.sessionId, status: 'booked',
      appointment: { startsAt: BOOKED_OUTCOME.appointment.startsAt, timezone: 'America/Chicago' }, reason: 'Booked.',
    }, { authorization: `Bearer ${SECRET}` });
    await app.outbox.drain();

    assert.equal((await app.scheduler.store.size()), 2, 'both reminder slots scheduled');

    clock.advance(APPT_MS - 3_600_000 - T0); // both slots now due
    await app.scheduler.drain();
    assert.deepEqual(sent.sort(), [
      reminderKey(created.sessionId, '1h'), reminderKey(created.sessionId, '24h'),
    ], 'each slot delivered exactly once through the Notification Contract');
    await app.scheduler.drain();
    assert.equal(sent.length, 2, 'no repeats on later drains');

    // Operations: the generic feed and notifications views tell the story.
    const cookieRes = await post('/api/v1/auth/login', { credential: 'dev-key-ops-0123456789abcdef' });
    const cookie = { cookie: `gh_session=${(cookieRes.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1]}` };
    const events = await (await fetch(`${base}/api/v1/operations/events?limit=50`, { headers: cookie })).json();
    const names = events.events.map((e) => e.name);
    assert.ok(names.includes('scheduler.action_scheduled'), 'reminder scheduled is visible');
    assert.ok(names.includes('scheduler.action_completed'), 'reminder execution is visible');
    assert.ok(names.includes('notification.delivered'), 'reminder delivery is visible');

    const list = await (await fetch(`${base}/api/v1/operations/notifications`, { headers: cookie })).json();
    const reminders = list.notifications.filter((n) => n.type === 'appointment-reminder');
    assert.equal(reminders.length, 2, 'the <type>:<sessionId>:<qualifier> keys parse in the generic view');
    assert.ok(reminders.every((n) => n.sessionId === created.sessionId && n.status === 'sent'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
