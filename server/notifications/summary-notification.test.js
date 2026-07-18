'use strict';

/**
 * Consultation Summary migration tests (ADR-0011 §8, Issue #47).
 *
 * Proves: wording preserved byte for byte; the conversation workflow's
 * response contract unchanged; the notification layer owns type,
 * template, idempotency, provider, and telemetry; the durable outbox
 * recovery consumer closes the crash gap without introducing background
 * retries; Operations displays summary states with zero special-purpose
 * code; and a future type is one template plus one registration.
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
const { buildConsultationSummary, renderSummaryHtml, summarySubject } = require('../handoff/summary');
const { createOutbox, createInMemoryOutboxStore } = require('../outbox/outbox');
const { createNotificationProviderRegistry } = require('./contract');
const { createInMemoryNotificationDeliveryStore } = require('./delivery-store');
const { createNotificationService } = require('./service');
const { renderNotificationRequest, registerNotificationRenderer } = require('./templates');
const {
  SUMMARY_TYPE, SUMMARY_PROVIDER_KEY, summaryNotificationKey,
  registerConsultationSummaryTemplate, createSummaryMailerProvider,
  createSummaryNotifier, registerSummaryRecovery,
} = require('./summary-notification');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';
const STALE_CLAIM_MS = 5 * 60 * 1000;

function fakeMailer() {
  const sends = [];
  const contexts = [];
  return {
    sends,
    contexts,
    enabled: true,
    async sendSummary(message, context) {
      sends.push(message);
      contexts.push(context);
      return { status: 'sent' };
    },
  };
}

function completedSession(overrides = {}) {
  const { session } = makeSession();
  return {
    ...session,
    status: 'booked',
    outcome: { ...BOOKED_OUTCOME },
    completedAtMs: T0,
    ...overrides,
  };
}

// ── Rendering: the template moved; the wording did not ──────────────────────

test('summary template: Notification Contract rendering is byte-identical to the domain artifact', () => {
  registerConsultationSummaryTemplate();
  const model = buildConsultationSummary(completedSession());
  const rendered = renderNotificationRequest({ type: SUMMARY_TYPE, model }, /* branding */ null);
  assert.equal(rendered.subject, summarySubject(model), 'subject preserved exactly');
  assert.equal(rendered.html, renderSummaryHtml(model), 'HTML body preserved exactly');
  assert.ok(rendered.text.includes('GuideHerd Consultation Summary'), 'plain-text alternative exists');
});

// ── The provider adapter: the existing Graph mailer boundary, unchanged ─────

test('summary-mailer provider: delivers the rendered summary through the mailer boundary with safe context only', async () => {
  const mailer = fakeMailer();
  const provider = createSummaryMailerProvider({ mailer });
  assert.equal(provider.providerKey, SUMMARY_PROVIDER_KEY);
  assert.equal(provider.enabled, true);

  const result = await provider.deliver(
    { rendered: { subject: 'S', html: '<p>H</p>', text: 'T' } },
    { correlationId: 'gh-c1', organizationKey: FIRM, sessionId: 's-1', notificationKey: 'k', extra: 'never-forwarded' },
  );
  assert.deepEqual(result, { status: 'sent' });
  assert.deepEqual(mailer.sends, [{ subject: 'S', html: '<p>H</p>' }], 'mailer sees subject and html only');
  assert.deepEqual(mailer.contexts, [{ correlationId: 'gh-c1', organizationKey: FIRM, sessionId: 's-1' }]);

  assert.equal(createSummaryMailerProvider({ mailer: { enabled: false, sendSummary: async () => ({ status: 'not-configured' }) } }).enabled, false);
});

// ── The notifier: intent in, status out ─────────────────────────────────────

function makeNotifier({ mailer = fakeMailer() } = {}) {
  registerConsultationSummaryTemplate();
  const clock = fixedClock(T0);
  const registry = createNotificationProviderRegistry();
  registry.register(createSummaryMailerProvider({ mailer }));
  const deliveryStore = createInMemoryNotificationDeliveryStore({ clock });
  const lines = [];
  const tel = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock });
  const notificationService = createNotificationService({
    registry, deliveryStore, telemetry: tel,
    typeProviders: { [SUMMARY_TYPE]: SUMMARY_PROVIDER_KEY },
  });
  const notifier = createSummaryNotifier({ notificationService, telemetry: tel });
  return { clock, mailer, deliveryStore, lines, notifier, notificationService };
}

test('summary notifier: delivers once per session; the notification claim suppresses duplicates as sent', async () => {
  const { mailer, deliveryStore, lines, notifier } = makeNotifier();
  const session = completedSession();

  assert.deepEqual(await notifier.deliver(session, { correlationId: 'gh-c1' }), { status: 'sent' });
  assert.equal(mailer.sends.length, 1);
  assert.equal((await deliveryStore.claim(summaryNotificationKey(session.sessionId))).status, 'sent');

  // The notification layer already settled this key: no provider call,
  // and the customer-visible truth ('sent') is what gets reported.
  assert.deepEqual(await notifier.deliver(session, {}), { status: 'sent' });
  assert.equal(mailer.sends.length, 1, 'sent is final at the notification layer too');

  const delivered = lines.filter((l) => l.event === 'guideherd.notification.delivered');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].notificationType, SUMMARY_TYPE);
});

test('summary notifier: a generation failure reports failed with the same safe diagnostic as before', async () => {
  const { mailer, lines, notifier } = makeNotifier();
  const broken = completedSession({ caller: null }); // model construction throws

  assert.deepEqual(await notifier.deliver(broken, { correlationId: 'gh-c2', organizationKey: FIRM }), { status: 'failed' });
  assert.equal(mailer.sends.length, 0, 'nothing rendered, nothing sent');

  const failures = lines.filter((l) => l.event === 'guideherd.summary.generation_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].component, 'handoff');
  assert.equal(failures[0].operation, 'summary-generation');
  assert.equal(failures[0].category, 'permanent_internal_failure');
  assert.equal(/Test Caller|caller@example\.com/.test(JSON.stringify(failures)), false, 'no PII in diagnostics');
});

// ── The recovery consumer: the crash gap closes; behavior does not change ───

function makeRecoveryRig() {
  const clock = fixedClock(T0);
  const outboxStore = createInMemoryOutboxStore({ clock });
  const store = createInMemoryHandoffStore({ clock, outbox: outboxStore });
  const outbox = createOutbox({ store: outboxStore, clock, maxAttempts: 5, backoffMs: [1000] });
  const { mailer, notifier } = makeNotifier();
  registerSummaryRecovery({ outbox, store, summaryNotifier: notifier });
  return { clock, store, outbox, outboxStore, mailer };
}

async function completeSessionOnStore(store) {
  const { session } = makeSession();
  await store.create(session);
  await store.connectEligible('org-a', {}, { correlationId: 'gh-recover1111111111111111' });
  const { session: updated } = await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME }, { correlationId: 'gh-recover1111111111111111' });
  return updated;
}

test('recovery: a crash before the summary attempt is healed from the durable event — exactly once', async () => {
  const { store, outbox, mailer } = makeRecoveryRig();
  // The outcome committed and published its event, but the process died
  // before the inline claim: summaryDelivery is still null.
  const session = await completeSessionOnStore(store);
  assert.equal(session.summaryDelivery ?? null, null);

  await outbox.drain();
  assert.equal(mailer.sends.length, 1, 'the durable event recovered the summary');
  assert.equal((await store.get(session.sessionId)).summaryDelivery, 'sent', 'session mirror recorded');
  await outbox.drain();
  await outbox.drain();
  assert.equal(mailer.sends.length, 1, 'redelivery never resends');
});

test('recovery: a terminal summary state settles the event silently — no background auto-retry appears', async () => {
  const { store, outbox, mailer } = makeRecoveryRig();
  const session = await completeSessionOnStore(store);
  // The inline path already ran and failed; the DOCUMENTED retry path is
  // an identical outcome report — not a background retry.
  await store.claimSummaryDelivery(session.sessionId);
  await store.recordSummaryDelivery(session.sessionId, 'failed');

  await outbox.drain();
  assert.equal(mailer.sends.length, 0, 'failed stays failed until an explicit retry');
  assert.equal((await store.get(session.sessionId)).summaryDelivery, 'failed');
});

test('recovery: a stale pending claim (crash mid-send) is reclaimed and completed', async () => {
  const { clock, store, outbox, mailer } = makeRecoveryRig();
  const session = await completeSessionOnStore(store);
  await store.claimSummaryDelivery(session.sessionId); // claimant dies mid-send

  await outbox.drain();
  assert.equal(mailer.sends.length, 0, 'a fresh claim is honored — the event retries instead');

  clock.advance(STALE_CLAIM_MS + 1000);
  await outbox.drain();
  assert.equal(mailer.sends.length, 1, 'the stale claim re-granted; the summary recovered');
  assert.equal((await store.get(session.sessionId)).summaryDelivery, 'sent');
});

// ── HTTP: end to end through the platform, response contract unchanged ──────

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
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: fakeMailer(),
    configService: configServiceWithFirm(),
    devUsersJson: DEV_USERS,
    ...opts,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app);
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
    caller: { fullName: 'Summary Caller', email: 'summary@example.com', phone: '+12565550177' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  })).json();
  await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
  const outcome = await (await post(base, '/api/v1/demo/outcome', {
    sessionId: created.sessionId, status: 'booked',
    appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' }, reason: 'Booked.',
  }, { authorization: `Bearer ${SECRET}` })).json();
  return { created, outcome };
}

test('HTTP: the summary flows through the Notification Contract — same response, same email, notification-layer truth', async () => {
  const mailer = fakeMailer();
  await withServer({ mailer }, async (base, app) => {
    const { created, outcome } = await bookedFlow(base);

    // The public response contract is unchanged.
    assert.equal(outcome.summaryDelivery, 'sent');
    assert.equal(mailer.sends.length, 1, 'exactly one summary email');
    assert.ok(mailer.sends[0].subject.startsWith('GuideHerd Consultation Summary — Summary Caller'));

    // The notification layer now owns the delivery record.
    const delivery = await app.notifications.deliveryStore.claim(`consultation-summary:${created.sessionId}`);
    assert.equal(delivery.claimed, false);
    assert.equal(delivery.status, 'sent');

    // The durable recovery consumer settled the event without a second send.
    await app.outbox.drain();
    assert.equal(mailer.sends.length, 1);
    assert.equal((await app.outbox.store.deliveryOf(2, 'consultation-summary')).status, 'completed');
  });
});

test('HTTP: Operations displays summary states with zero special-purpose code', async () => {
  await withServer({}, async (base, app) => {
    const { created } = await bookedFlow(base);
    await app.outbox.drain();

    const cookieRes = await post(base, '/api/v1/auth/login', { credential: 'dev-key-ops-0123456789abcdef' });
    const cookie = { cookie: `gh_session=${(cookieRes.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1]}` };

    const list = await (await fetch(`${base}/api/v1/operations/notifications`, { headers: cookie })).json();
    const summary = list.notifications.find((n) => n.type === 'consultation-summary');
    assert.ok(summary, 'the generic <type>:<sessionId> view surfaces the new type untouched');
    assert.equal(summary.sessionId, created.sessionId);
    assert.equal(summary.status, 'sent');
  });
});

// ── The extension point ─────────────────────────────────────────────────────

test('extension: a future notification type is one catalog line, one template registration — zero core changes', () => {
  // The catalog line (NOTIFICATION_TYPES/MODEL_TYPES) is the allowlist
  // entry; everything else is registration. Rendering dispatches through
  // the registry generically — the service, providers, and workflows are
  // untouched by a new type.
  registerNotificationRenderer('matter-intake-packet', (request) => ({
    subject: `Intake packet for ${request.model.matter}`,
    html: `<p>${request.model.matter}</p>`,
    text: request.model.matter,
  }));
  const rendered = renderNotificationRequest(
    { type: 'matter-intake-packet', model: { matter: 'Estate of Example' } },
    null,
  );
  assert.equal(rendered.subject, 'Intake packet for Estate of Example');
});
