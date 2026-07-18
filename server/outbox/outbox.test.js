'use strict';

/**
 * Durable Event Outbox tests (ADR-0017).
 *
 * Unit tests drive the store and processor against the in-memory
 * reference (PostgreSQL transactional/recovery legs live in
 * operational.test.js); HTTP tests prove the notification migration and
 * Operations Center integration end to end. Deterministic: fixed clocks,
 * no timers awaited, no providers.
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
const { makeSession, BOOKED_OUTCOME } = require('../operational/contract-suite');
const { createOutbox, createInMemoryOutboxStore, createOutboxPoller, OUTBOX_STALE_PROCESSING_MS, DEFAULT_MAX_ATTEMPTS } = require('./outbox');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

// ── Publishing and the transactional pass (memory reference) ────────────────

test('outbox: repositories publish domain events in the same atomic pass; failures and duplicates publish nothing', async () => {
  const clock = fixedClock(T0);
  const outboxStore = createInMemoryOutboxStore({ clock });
  const store = createInMemoryHandoffStore({ clock, outbox: outboxStore });

  const { session } = makeSession();
  await store.create(session);
  await store.connectEligible('org-a', {}, { correlationId: 'gh-outboxaaaaaaaaaaaaaaaa1' });
  await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME }, { correlationId: 'gh-outboxaaaaaaaaaaaaaaaa1' });

  assert.equal(await outboxStore.size(), 2);
  const events = await outboxStore.listRecent({ organizationKey: 'org-a' });
  assert.deepEqual(events.map((e) => e.type), ['conversation.completed', 'conversation.connected']);
  assert.equal(events[0].payload.status, 'booked');
  assert.equal(events[0].correlationId, 'gh-outboxaaaaaaaaaaaaaaaa1');

  // A failed business operation publishes nothing…
  await assert.rejects(() => store.applyOutcome(session.sessionId, { status: 'failed', schedulingSummary: 'No.' }));
  // …and an idempotent duplicate publishes nothing new.
  await store.applyOutcome(session.sessionId, JSON.parse(JSON.stringify(BOOKED_OUTCOME)));
  assert.equal(await outboxStore.size(), 2);

  // Event payloads carry safe facts only.
  assert.equal(/Test Caller|caller@example\.com|gh_handoff_|tokenHash/.test(JSON.stringify(events)), false);
});

test('outbox: publisher contract is validated — malformed events are programming errors', async () => {
  const store = createInMemoryOutboxStore({ clock: fixedClock(T0) });
  await assert.rejects(() => store.append({ type: '', organizationKey: 'o' }), TypeError);
  await assert.rejects(() => store.append({ type: 'x' }), TypeError);
});

// ── The processor: delivery, retries, isolation ─────────────────────────────

function makeProcessor({ maxAttempts = 3 } = {}) {
  const clock = fixedClock(T0);
  const store = createInMemoryOutboxStore({ clock });
  const outbox = createOutbox({ store, clock, maxAttempts, backoffMs: [1000, 5000] });
  return { clock, store, outbox };
}

test('outbox: consumers register once; duplicates and malformed registrations fail loudly', () => {
  const { outbox } = makeProcessor();
  outbox.register({ consumer: 'a', handle: async () => {} });
  assert.throws(() => outbox.register({ consumer: 'a', handle: async () => {} }), /already registered/);
  assert.throws(() => outbox.register({ consumer: '' }), TypeError);
  assert.deepEqual(outbox.consumerNames(), ['a']);
});

test('outbox: delivery, duplicate suppression, and event ordering', async () => {
  const { store, outbox } = makeProcessor();
  const seen = [];
  outbox.register({ consumer: 'orderly', handle: async (e) => { seen.push(e.type + ':' + e.payload.n); } });
  await store.append({ type: 't', organizationKey: 'org-a', payload: { n: 1 } });
  await store.append({ type: 't', organizationKey: 'org-a', payload: { n: 2 } });
  await store.append({ type: 't', organizationKey: 'org-a', payload: { n: 3 } });

  await outbox.drain();
  assert.deepEqual(seen, ['t:1', 't:2', 't:3'], 'publication order within a drain pass');
  await outbox.drain();
  await outbox.drain();
  assert.equal(seen.length, 3, 'completed deliveries never redeliver');
});

test('outbox: consumer retry with deterministic backoff; exhaustion abandons', async () => {
  const { clock, store, outbox } = makeProcessor({ maxAttempts: 3 });
  let attempts = 0;
  outbox.register({ consumer: 'flaky', handle: async () => { attempts += 1; throw new Error('down'); } });
  const event = await store.append({ type: 't', organizationKey: 'org-a' });

  await outbox.drain();
  assert.equal(attempts, 1);
  assert.equal((await store.deliveryOf(event.id, 'flaky')).status, 'failed');

  await outbox.drain();
  assert.equal(attempts, 1, 'backoff holds: not yet retryable');
  clock.advance(1000);
  await outbox.drain();
  assert.equal(attempts, 2, 'retry after backoff');
  clock.advance(5000);
  await outbox.drain();
  assert.equal(attempts, 3, 'final attempt');
  assert.equal((await store.deliveryOf(event.id, 'flaky')).status, 'abandoned');
  clock.advance(60_000);
  await outbox.drain();
  assert.equal(attempts, 3, 'abandoned is terminal');
});

test('outbox: consumer isolation and multiple consumers — one failure never blocks another', async () => {
  const { store, outbox } = makeProcessor();
  const delivered = [];
  outbox.register({ consumer: 'healthy', handle: async (e) => { delivered.push(e.id); } });
  outbox.register({ consumer: 'broken', handle: async () => { throw new Error('boom'); } });
  const event = await store.append({ type: 't', organizationKey: 'org-a' });

  await outbox.drain();
  assert.deepEqual(delivered, [event.id], 'the healthy consumer completed');
  assert.equal((await store.deliveryOf(event.id, 'healthy')).status, 'completed');
  assert.equal((await store.deliveryOf(event.id, 'broken')).status, 'failed');
});

test('outbox: eventTypes filtering settles unsubscribed events; a stale processing claim re-claims (crash recovery)', async () => {
  const { clock, store, outbox } = makeProcessor();
  const handled = [];
  outbox.register({ consumer: 'typed', eventTypes: ['wanted'], handle: async (e) => { handled.push(e.type); } });
  await store.append({ type: 'unwanted', organizationKey: 'org-a' });
  await store.append({ type: 'wanted', organizationKey: 'org-a' });
  await outbox.drain();
  assert.deepEqual(handled, ['wanted']);
  assert.equal((await store.deliveryOf(1, 'typed')).status, 'completed', 'unsubscribed events settle and never requeue');

  // Crash mid-processing: a claim goes stale, then re-claims (at-least-once).
  const crash = await store.append({ type: 'wanted', organizationKey: 'org-a' });
  await store.claim(crash.id, 'typed'); // simulated dying processor
  await outbox.drain();
  assert.equal(handled.length, 1, 'fresh processing claim blocks concurrent delivery');
  clock.advance(OUTBOX_STALE_PROCESSING_MS);
  await outbox.drain();
  assert.deepEqual(handled, ['wanted', 'wanted'], 'stale claim re-claimed — delivery is at least once');
});

test('outbox: the extension point — one event definition, one publisher, one consumer registration, zero core changes', async () => {
  const { store, outbox } = makeProcessor();
  // A future subsystem defines an event and publishes it inside its own
  // business pass; a future capability registers a consumer. Neither
  // knows the other; the outbox core is untouched.
  const reminders = [];
  outbox.register({
    consumer: 'reminder-scheduler',
    eventTypes: ['appointment.booked-for-reminders'],
    handle: async (e) => { reminders.push(e.payload.startsAt); },
  });
  await store.append({
    type: 'appointment.booked-for-reminders',
    organizationKey: FIRM,
    sessionId: 's-9',
    payload: { startsAt: '2026-07-20T15:00:00-05:00' },
  });
  await outbox.drain();
  assert.deepEqual(reminders, ['2026-07-20T15:00:00-05:00']);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 5);
});

// ── The poller: liveness without traffic or restarts ────────────────────────

/** Deterministic timers: nothing fires until the test says so. */
function fakeTimers() {
  let nextHandle = 1;
  const armed = new Map();
  return {
    set(fn, ms) { const handle = nextHandle++; armed.set(handle, { fn, ms }); return handle; },
    clear(handle) { armed.delete(handle); },
    pending() { return armed.size; },
    /** Fire the (single) armed timer and await its full tick. */
    async fire() {
      assert.equal(armed.size, 1, 'exactly one armed poll timer');
      const [handle, entry] = armed.entries().next().value;
      armed.delete(handle);
      await entry.fn();
    },
  };
}

test('outbox poller: a retry in backoff becomes eligible and completes with NO new business request', async () => {
  const { clock, store, outbox } = makeProcessor();
  let attempts = 0;
  outbox.register({ consumer: 'flaky', handle: async () => { attempts += 1; if (attempts === 1) throw new Error('down'); } });
  const event = await store.append({ type: 't', organizationKey: 'org-a' });
  await outbox.drain(); // the post-commit nudge: first attempt fails into backoff
  assert.equal((await store.deliveryOf(event.id, 'flaky')).status, 'failed');

  const timers = fakeTimers();
  const poller = createOutboxPoller({ outbox, intervalMs: 15_000, timers });
  poller.start();
  await timers.fire();
  assert.equal(attempts, 1, 'backoff still holds — the poller respects retry timing');
  clock.advance(1000); // ONLY time passes: no publish, no request, no restart
  await timers.fire();
  assert.equal(attempts, 2, 'the poller retried the delivery');
  assert.equal((await store.deliveryOf(event.id, 'flaky')).status, 'completed');
  poller.stop();
});

test('outbox poller: a stale processing claim is reclaimed without a restart', async () => {
  const { clock, store, outbox } = makeProcessor();
  const handled = [];
  outbox.register({ consumer: 'survivor', handle: async (e) => { handled.push(e.id); } });
  const event = await store.append({ type: 't', organizationKey: 'org-a' });
  await store.claim(event.id, 'survivor'); // a processor claimed, then died mid-processing

  const timers = fakeTimers();
  const poller = createOutboxPoller({ outbox, intervalMs: 15_000, timers });
  poller.start();
  await timers.fire();
  assert.deepEqual(handled, [], 'a fresh claim is honored — no double processing');
  clock.advance(OUTBOX_STALE_PROCESSING_MS);
  await timers.fire();
  assert.deepEqual(handled, [event.id], 'the stale claim re-claimed on poll alone');
  assert.equal((await store.deliveryOf(event.id, 'survivor')).status, 'completed');
  poller.stop();
});

test('outbox poller: two instances polling the same store produce exactly one business effect', async () => {
  const clock = fixedClock(T0);
  const store = createInMemoryOutboxStore({ clock });
  let effects = 0;
  const instance = () => {
    const outbox = createOutbox({ store, clock, maxAttempts: 3, backoffMs: [1000] });
    outbox.register({ consumer: 'notifications', handle: async () => { effects += 1; } });
    return outbox;
  };
  const timersA = fakeTimers();
  const timersB = fakeTimers();
  const pollerA = createOutboxPoller({ outbox: instance(), intervalMs: 1000, timers: timersA });
  const pollerB = createOutboxPoller({ outbox: instance(), intervalMs: 1000, timers: timersB });
  pollerA.start();
  pollerB.start();
  await store.append({ type: 't', organizationKey: 'org-a' });

  await Promise.all([timersA.fire(), timersB.fire()]); // both instances poll concurrently
  assert.equal(effects, 1, 'the atomic delivery claim lets exactly one instance deliver');
  assert.equal((await store.deliveryOf(1, 'notifications')).status, 'completed');
  pollerA.stop();
  pollerB.stop();
});

test('outbox poller: shutdown leaves no timers; loops never overlap; start/stop are idempotent', async () => {
  const timers = fakeTimers();
  const poller = createOutboxPoller({ outbox: { drain: async () => {} }, intervalMs: 1000, timers });
  poller.start();
  poller.start();
  assert.equal(timers.pending(), 1, 'double start arms exactly one timer');
  poller.stop();
  poller.stop();
  assert.equal(timers.pending(), 0, 'no timers or open handles after shutdown');
  assert.equal(poller.isRunning(), false);
  poller.start();
  assert.equal(timers.pending(), 1, 'restartable after a clean stop');
  poller.stop();

  // While a drain is in flight there is NO armed timer — the next poll is
  // armed only after the drain resolves, so loops cannot overlap; and a
  // stop() during the drain means no re-arm afterward.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowTimers = fakeTimers();
  const slow = createOutboxPoller({ outbox: { drain: () => gate }, intervalMs: 1000, timers: slowTimers });
  slow.start();
  const firing = slowTimers.fire();
  assert.equal(slowTimers.pending(), 0, 'mid-drain: nothing armed, overlap is impossible');
  slow.stop();
  release();
  await firing;
  assert.equal(slowTimers.pending(), 0, 'stopped mid-drain: never re-armed');
});

test('outbox poller: an empty queue polls silently — zero telemetry events', async () => {
  const clock = fixedClock(T0);
  const emitted = [];
  const outbox = createOutbox({
    store: createInMemoryOutboxStore({ clock }),
    clock,
    telemetry: { event: (name) => { emitted.push(name); } },
  });
  outbox.register({ consumer: 'quiet', handle: async () => {} });
  const timers = fakeTimers();
  const poller = createOutboxPoller({ outbox, intervalMs: 1000, timers });
  poller.start();
  await timers.fire();
  await timers.fire();
  await timers.fire();
  assert.deepEqual(emitted, [], 'idle polling emits nothing');
  poller.stop();
});

test('outbox poller: configuration is validated as a programming contract', () => {
  assert.throws(() => createOutboxPoller({ outbox: {} }), TypeError);
  assert.throws(() => createOutboxPoller({ outbox: { drain: async () => {} }, intervalMs: 0 }), TypeError);
  assert.throws(() => createOutboxPoller({ outbox: { drain: async () => {} }, intervalMs: NaN }), TypeError);
});

// ── HTTP: notification migration + Operations integration ──────────────────

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

async function withServer(opts, fn) {
  const configService = configServiceWithFirm();
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    configService,
    devUsersJson: DEV_USERS,
    ...opts,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app, configService);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function bookedFlow(base) {
  const created = await (await post(base, '/api/v1/handoffs', {
    firmId: FIRM,
    caller: { fullName: 'Outbox Caller', email: 'outbox@example.com', phone: '+12565550100' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  })).json();
  await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
  const outcome = {
    sessionId: created.sessionId, status: 'booked',
    appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' }, reason: 'Booked.',
  };
  await post(base, '/api/v1/demo/outcome', outcome, { authorization: `Bearer ${SECRET}` });
  return { created, outcome };
}

test('HTTP: notifications consume the durable event — identical behavior, exactly one confirmation under duplicates', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'notifications', 'appointment-confirmation', { enabled: true });
  await withServer({ configService }, async (base, app) => {
    const sent = [];
    app.notifications.registry.register({
      providerKey: 'capture',
      async deliver(message, context) { sent.push(context.notificationKey); return { status: 'sent' }; },
    });
    configService.settings.set(FIRM, 'notifications', 'provider', { provider: 'capture' });

    const { created, outcome } = await bookedFlow(base);
    await post(base, '/api/v1/demo/outcome', outcome, { authorization: `Bearer ${SECRET}` }); // duplicate report
    await app.outbox.drain();
    await app.outbox.drain(); // redelivery attempts change nothing

    assert.deepEqual(sent, [`appointment-confirmation:${created.sessionId}`], 'exactly one customer notification, ever');
    assert.equal((await app.outbox.store.deliveryOf(2, 'notifications')).status, 'completed');
  });
});

test('HTTP: disabled by default remains disabled — the durable event settles without sending', async () => {
  await withServer({}, async (base, app) => {
    const sent = [];
    app.notifications.registry.register({
      providerKey: 'capture',
      async deliver(message, context) { sent.push(context.notificationKey); return { status: 'sent' }; },
    });
    await bookedFlow(base);
    await app.outbox.drain();
    assert.equal(sent.length, 0, 'no customer notification without the explicit setting');
    assert.equal((await app.outbox.store.deliveryOf(2, 'notifications')).status, 'completed', 'the event settles; enabling later never resends history');
  });
});

test('HTTP: the Operations Center consumes the durable source — conversation history survives in the outbox', async () => {
  await withServer({}, async (base, app) => {
    const { created } = await bookedFlow(base);
    await app.outbox.drain();

    const cookieRes = await post(base, '/api/v1/auth/login', { credential: 'dev-key-ops-0123456789abcdef' });
    const cookie = { cookie: `gh_session=${(cookieRes.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1]}` };

    const events = await (await fetch(`${base}/api/v1/operations/events?limit=20`, { headers: cookie })).json();
    const durable = events.events.filter((e) => e.durable);
    assert.deepEqual(durable.map((e) => e.name).sort(), ['conversation.completed', 'conversation.connected'],
      'conversation lifecycle reaches the feed from the DURABLE outbox, not the ephemeral ring');
    assert.ok(durable.every((e) => e.fields.sessionId === created.sessionId));

    // The timeline still combines lifecycle + conversation entries.
    const cid = durable[0].fields.correlationId;
    const timeline = await (await fetch(`${base}/api/v1/operations/timeline/${cid}`, { headers: cookie })).json();
    const kinds = new Set(timeline.entries.map((e) => e.kind));
    assert.ok(kinds.has('handoff') && kinds.has('conversation'));
  });
});
