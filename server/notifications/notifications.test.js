'use strict';

/**
 * Notification Contract tests (ADR-0011).
 *
 * Covers the contract, templates, branding, delivery idempotency, the
 * Graph provider translation and retry behavior, telemetry integration,
 * config-driven provider selection, and the end-to-end booked-confirmation
 * trigger — including the guarantee that it is disabled by default and
 * that retries can never duplicate a customer notification.
 *
 * All deterministic: fixed clocks, injected fetch/sleep, captured logs.
 * No provider is ever called.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createTelemetry } = require('../telemetry/telemetry');
const { NOTIFICATION_TYPES, validateNotificationRequest, createNotificationProviderRegistry } = require('./contract');
const { resolveBranding } = require('./branding');
const { buildTemplateModel, renderNotification } = require('./templates');
const { createInMemoryNotificationDeliveryStore } = require('./delivery-store');
const { createGraphEmailProvider } = require('./graph-email-provider');
const { createNotificationService, resolveNotificationProviderKey, DEFAULT_NOTIFICATION_PROVIDER } = require('./service');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

function validRequest(overrides = {}) {
  return {
    type: 'appointment-confirmation',
    organizationKey: FIRM,
    notificationKey: 'appointment-confirmation:sess-1',
    recipient: { name: 'Ryan Scoggins', email: 'ryan@example.com' },
    appointment: {
      startsAt: '2026-07-20T15:00:00-05:00',
      timezone: 'America/Chicago',
      attorneyName: 'Clay Martinson',
      consultationType: 'Initial Consultation',
    },
    ...overrides,
  };
}

function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  return configService;
}

function capturedTelemetry() {
  const lines = [];
  return { lines, tel: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) }) };
}

// ── Contract ────────────────────────────────────────────────────────────────

// The four appointment types share the appointment-shaped request;
// consultation-summary is a MODEL type (bespoke payload, firm-facing).
const APPOINTMENT_TYPES = [
  'appointment-confirmation', 'appointment-cancellation', 'appointment-rescheduled', 'appointment-reminder',
];

test('contract: every notification type validates and canonicalizes', () => {
  assert.deepEqual([...NOTIFICATION_TYPES], [...APPOINTMENT_TYPES, 'consultation-summary']);
  for (const type of APPOINTMENT_TYPES) {
    const validated = validateNotificationRequest(validRequest({ type }));
    assert.equal(validated.type, type);
    assert.equal(validated.locale, 'en-US', 'locale defaults');
  }
  // The model type: recipient is optional (the delivery boundary owns the
  // firm-facing target); the model payload is required; the appointment
  // shape is rejected — no shape-smuggling between kinds.
  const summary = validateNotificationRequest({
    type: 'consultation-summary', organizationKey: 'org-a',
    notificationKey: 'consultation-summary:sess-1', model: { any: 'model' },
  });
  assert.equal(summary.recipient, null);
  assert.deepEqual(summary.model, { any: 'model' });
  assert.throws(() => validateNotificationRequest({
    type: 'consultation-summary', organizationKey: 'org-a',
    notificationKey: 'k', model: { a: 1 }, appointment: { startsAt: 'x' },
  }), /appointment is not accepted/);
  assert.throws(() => validateNotificationRequest({
    type: 'consultation-summary', organizationKey: 'org-a', notificationKey: 'k',
  }), /model required/);
  assert.throws(() => validateNotificationRequest(validRequest({ model: { a: 1 } })), /model is only accepted/);
});

test('contract: strict allowlist — unknown keys, bad recipients, and bad appointments are rejected', () => {
  assert.throws(() => validateNotificationRequest(validRequest({ providerPayload: {} })), /unknown key/);
  assert.throws(() => validateNotificationRequest(validRequest({ type: 'marketing-blast' })), /unknown type/);
  assert.throws(() => validateNotificationRequest(validRequest({ recipient: { email: '' } })), /recipient\.email/);
  assert.throws(() => validateNotificationRequest(validRequest({ recipient: { email: 'x@y.z', transcript: 'hi' } })), /unknown recipient key/);
  assert.throws(() => validateNotificationRequest(validRequest({ appointment: { startsAt: 'not-a-date', timezone: 'America/Chicago' } })), /startsAt/);
  assert.throws(() => validateNotificationRequest(validRequest({ notificationKey: '' })), /notificationKey/);
});

test('contract: registry resolves providers and fails loudly on unknown ones', () => {
  const registry = createNotificationProviderRegistry();
  const provider = registry.register({ providerKey: 'test-mail', deliver: async () => ({ status: 'sent' }) });
  assert.equal(registry.resolve('test-mail'), provider);
  assert.throws(() => registry.resolve('smtp'), (e) => e.code === 'notification_provider_unavailable');
  assert.throws(() => registry.register({ providerKey: 'x' }), TypeError, 'deliver() required');
});

// ── Templates and branding ──────────────────────────────────────────────────

test('templates: every type renders subject, HTML, and plain text with firm branding and no provider names', () => {
  const configService = configServiceWithFirm();
  const branding = resolveBranding(configService, FIRM);
  assert.equal(branding.senderName, 'Martinson & Beason, P.C.', 'sender defaults to the firm name');

  for (const type of APPOINTMENT_TYPES) {
    const request = validateNotificationRequest(validRequest({ type }));
    const rendered = renderNotification(buildTemplateModel(request, branding));
    assert.ok(rendered.subject.includes('Martinson & Beason, P.C.'), `${type}: firm-branded subject`);
    assert.ok(rendered.html.includes('Martinson &amp; Beason'), `${type}: firm in HTML (escaped)`);
    assert.ok(rendered.text.includes('Monday, July 20, 2026'), `${type}: human-readable time in text`);
    assert.ok(rendered.text.includes('America/Chicago'), `${type}: timezone shown`);
    assert.ok(rendered.html.includes('Clay Martinson'), `${type}: attorney shown`);
    const all = rendered.subject + rendered.html + rendered.text;
    assert.equal(/cal\.com|calcom|microsoft|graph|outlook|smtp|twilio|elevenlabs|guideherd/i.test(all), false,
      `${type}: no provider or implementation branding`);
  }
});

test('templates: HTML-escapes untrusted values and honors branding overrides', () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'notifications', 'branding', {
    senderName: 'M&B Law',
    accentColor: '#aa0000',
    footerText: 'Questions? Call the office.',
    office: { phone: '(256) 555-0100', email: 'office@example.com' },
    logoUrl: 'https://example.com/logo.png',
  });
  const branding = resolveBranding(configService, FIRM);
  assert.equal(branding.senderName, 'M&B Law');
  assert.equal(branding.office.phone, '(256) 555-0100');

  const request = validateNotificationRequest(validRequest({
    recipient: { name: '<script>alert(1)</script>', email: 'x@example.com' },
  }));
  const rendered = renderNotification(buildTemplateModel(request, branding));
  assert.equal(rendered.html.includes('<script>'), false, 'markup is escaped');
  assert.ok(rendered.html.includes('#aa0000'), 'accent color applied');
  assert.ok(rendered.html.includes('https://example.com/logo.png'), 'logo applied');
  assert.ok(rendered.text.includes('Questions? Call the office.'), 'footer override in text');
});

test('branding: fail-safe defaults without a config store; non-https logos rejected', () => {
  const branding = resolveBranding(null, 'unknown-org');
  assert.equal(branding.senderName, 'Your law office');
  assert.equal(branding.logoUrl, null);

  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'notifications', 'branding', { logoUrl: 'http://insecure.example/logo.png' });
  assert.equal(resolveBranding(configService, FIRM).logoUrl, null, 'http logo rejected');
});

// ── Service: idempotency and provider selection ─────────────────────────────

function makeService({ provider, configService = configServiceWithFirm() } = {}) {
  const clock = fixedClock(T0);
  const registry = createNotificationProviderRegistry();
  const delivered = [];
  registry.register(provider || {
    providerKey: DEFAULT_NOTIFICATION_PROVIDER,
    async deliver(message, context) {
      delivered.push({ message, context });
      return { status: 'sent', providerRequestId: 'prov-1' };
    },
  });
  const deliveryStore = createInMemoryNotificationDeliveryStore({ clock });
  const { lines, tel } = capturedTelemetry();
  const service = createNotificationService({ registry, deliveryStore, configService, telemetry: tel });
  return { service, delivered, deliveryStore, lines, clock, configService };
}

test('service: delivers each notification type exactly once; duplicates and retries are suppressed', async () => {
  const { service, delivered, lines } = makeService();

  for (const type of APPOINTMENT_TYPES) {
    const request = validRequest({ type, notificationKey: `${type}:sess-9` });
    assert.deepEqual(await service.send(request, { correlationId: 'gh-abc123def456abc123def456' }), { status: 'sent' });
  }
  assert.equal(delivered.length, 4, 'one delivery per type');

  // Retry storm on one key: zero additional provider calls.
  const dup = validRequest({ notificationKey: `appointment-confirmation:sess-9` });
  const results = await Promise.all([1, 2, 3].map(() => service.send(dup)));
  for (const r of results) assert.deepEqual(r, { status: 'suppressed', suppressedBy: 'sent' });
  assert.equal(delivered.length, 4, 'sent is final: no duplicate customer notification, ever');

  const suppressed = lines.filter((l) => l.event === 'guideherd.notification.suppressed');
  assert.equal(suppressed.length, 3);
  assert.equal(suppressed[0].code, 'already_sent');
  const deliveredEvents = lines.filter((l) => l.event === 'guideherd.notification.delivered');
  assert.equal(deliveredEvents.length, 4);
  assert.equal(deliveredEvents[0].correlationId, 'gh-abc123def456abc123def456');
});

test('service: a failed delivery may be retried later; success then becomes final', async () => {
  let behavior = 'failed';
  const { service, delivered } = makeService({
    provider: {
      providerKey: DEFAULT_NOTIFICATION_PROVIDER,
      async deliver(message) {
        delivered.push(message);
        return { status: behavior };
      },
    },
  });
  const delivered2 = [];
  // (delivered array from makeService's default is unused with custom provider)
  const request = validRequest();
  assert.deepEqual(await service.send(request), { status: 'failed' });
  behavior = 'sent';
  assert.deepEqual(await service.send(request), { status: 'sent' }, 'failed permits a later retry');
  assert.deepEqual(await service.send(request), { status: 'suppressed', suppressedBy: 'sent' });
  void delivered2;
});

test('service: provider selection is configuration; unknown providers fail loudly and record failed', async () => {
  const configService = configServiceWithFirm();
  assert.equal(resolveNotificationProviderKey(configService, FIRM), DEFAULT_NOTIFICATION_PROVIDER);
  configService.settings.set(FIRM, 'notifications', 'provider', { provider: 'sms-gateway' });
  assert.equal(resolveNotificationProviderKey(configService, FIRM), 'sms-gateway');

  const { service, delivered, deliveryStore, lines } = makeService({ configService });
  const result = await service.send(validRequest());
  assert.deepEqual(result, { status: 'failed' }, 'unregistered provider: loud failure, no silent substitute');
  assert.equal(delivered.length, 0, 'no provider was called');
  assert.equal((await deliveryStore.get('appointment-confirmation:sess-1')).status, 'failed', 're-claimable later');
  assert.ok(lines.some((l) => l.event === 'guideherd.notification.delivery_failed' && l.code === 'notification_provider_unavailable'));
});

test('service: a provider returning nonsense fails closed', async () => {
  const { service } = makeService({
    provider: { providerKey: DEFAULT_NOTIFICATION_PROVIDER, async deliver() { return { status: 'delivered-ish' }; } },
  });
  assert.deepEqual(await service.send(validRequest()), { status: 'failed' });
});

// ── Graph email provider ────────────────────────────────────────────────────

const MAIL_ENV = {
  MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 'graph-secret-value',
  SUMMARY_MAILBOX: 'mb@example.com',
};

function fakeGraph(responses) {
  const calls = { token: 0, send: 0, bodies: [] };
  const fetchImpl = async (url, options) => {
    if (String(url).includes('login.microsoftonline.com')) {
      calls.token += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), headers: { get: () => null } };
    }
    calls.send += 1;
    calls.bodies.push(JSON.parse(options.body));
    const behavior = responses[Math.min(calls.send - 1, responses.length - 1)];
    if (behavior instanceof Error) throw behavior;
    return { ok: behavior === 202, status: behavior, json: async () => ({}), headers: { get: (h) => (h === 'request-id' ? 'graph-req-9' : null) } };
  };
  return { fetchImpl, calls };
}

function renderedFixture() {
  const configService = configServiceWithFirm();
  const branding = resolveBranding(configService, FIRM);
  const request = validateNotificationRequest(validRequest());
  return { rendered: renderNotification(buildTemplateModel(request, branding)), recipient: request.recipient, branding };
}

test('graph provider: translates the rendered notification into a delivery; GuideHerd content only', async () => {
  const { fetchImpl, calls } = fakeGraph([202]);
  const provider = createGraphEmailProvider({ env: MAIL_ENV, fetchImpl, sleep: async () => {} });
  const message = renderedFixture();
  const result = await provider.deliver(message, { correlationId: 'gh-abc123def456abc123def456' });
  assert.deepEqual(result, { status: 'sent', providerRequestId: 'graph-req-9' });

  const sent = calls.bodies[0];
  assert.equal(sent.message.subject, message.rendered.subject, 'GuideHerd-rendered subject');
  assert.equal(sent.message.toRecipients[0].emailAddress.address, 'ryan@example.com', 'GuideHerd-decided recipient');
  assert.equal(sent.message.toRecipients[0].emailAddress.name, 'Ryan Scoggins');
  assert.equal(sent.message.body.content, message.rendered.html);
});

test('graph provider: 429 retries then succeeds; auth failure and rejection never retry; timeout is ambiguous and never retried', async () => {
  {
    const { fetchImpl, calls } = fakeGraph([429, 202]);
    const provider = createGraphEmailProvider({ env: MAIL_ENV, fetchImpl, sleep: async () => {} });
    assert.equal((await provider.deliver(renderedFixture(), {})).status, 'sent');
    assert.equal(calls.send, 2, 'rate limit retried');
  }
  for (const [status, expectedEvent] of [[401, 'guideherd.provider.authentication_failed'], [400, 'guideherd.provider.rejected_request']]) {
    const { fetchImpl, calls } = fakeGraph([status]);
    const { lines, tel } = capturedTelemetry();
    const provider = createGraphEmailProvider({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
    assert.equal((await provider.deliver(renderedFixture(), {})).status, 'failed');
    assert.equal(calls.send, 1, `${status} not retried`);
    assert.equal(lines[0].event, expectedEvent);
  }
  {
    const abort = new Error('aborted'); abort.name = 'AbortError';
    const { fetchImpl, calls } = fakeGraph([abort]);
    const { lines, tel } = capturedTelemetry();
    const provider = createGraphEmailProvider({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
    assert.equal((await provider.deliver(renderedFixture(), {})).status, 'failed');
    assert.equal(calls.send, 1, 'ambiguous timeout never retried — duplicate customer email risk');
    assert.equal(lines[0].event, 'guideherd.provider.timeout');
  }
  {
    const { fetchImpl, calls } = fakeGraph([503, 503, 503]);
    const { lines, tel } = capturedTelemetry();
    const provider = createGraphEmailProvider({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
    assert.equal((await provider.deliver(renderedFixture(), {})).status, 'failed');
    assert.equal(calls.send, 3, 'unavailable retried within bounds');
    assert.deepEqual(lines.map((l) => l.event).slice(-2), ['guideherd.retry.exhausted', 'guideherd.provider.unavailable']);
  }
});

test('graph provider: unconfigured is a controlled not-configured; telemetry never carries content or secrets', async () => {
  const provider = createGraphEmailProvider({ env: {}, sleep: async () => {} });
  assert.deepEqual(await provider.deliver(renderedFixture(), {}), { status: 'not-configured' });

  const { fetchImpl } = fakeGraph([429, 429, 429]);
  const { lines, tel } = capturedTelemetry();
  const failing = createGraphEmailProvider({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
  await failing.deliver(renderedFixture(), { correlationId: 'gh-abc123def456abc123def456', notificationType: 'appointment-confirmation' });
  const flat = JSON.stringify(lines);
  assert.equal(/graph-secret-value|ryan@example\.com|Scoggins|confirmed|<div|tok/.test(flat), false,
    'no secrets, recipients, or rendered content in telemetry');
  assert.ok(lines.every((l) => l.notificationType === 'appointment-confirmation'));
});

// ── End to end: the booked-confirmation trigger ─────────────────────────────

async function withServer(opts, fn) {
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
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

const bridgeAuth = { authorization: `Bearer ${SECRET}` };

function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function createBody() {
  return {
    firmId: FIRM,
    caller: { fullName: 'Ryan Scoggins', email: 'ryan@example.com', phone: '+12565550100' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

async function bookedFlow(base) {
  const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
  await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
  const outcome = {
    sessionId: created.sessionId,
    status: 'booked',
    appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
    reason: 'Booked.',
  };
  await post(base, '/api/v1/demo/outcome', outcome, bridgeAuth);
  return { created, outcome };
}

/** Register a capturing notification provider and select it via config. */
function useCapturingProvider(app, configService) {
  const sent = [];
  app.notifications.registry.register({
    providerKey: 'capture',
    async deliver(message, context) { sent.push({ message, context }); return { status: 'sent' }; },
  });
  configService.settings.set(FIRM, 'notifications', 'provider', { provider: 'capture' });
  return sent;
}

test('HTTP: the confirmation trigger is DISABLED by default — current customer behavior is unchanged', async () => {
  const configService = configServiceWithFirm();
  await withServer({ configService }, async (base, app) => {
    const sent = useCapturingProvider(app, configService);
    await bookedFlow(base);
    await new Promise((r) => setImmediate(r)); // let the async trigger settle
    assert.equal(sent.length, 0, 'no customer notification without the explicit setting');
  });
});

test('HTTP: with the setting enabled, a booked outcome sends exactly one branded confirmation — retries suppressed', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'notifications', 'appointment-confirmation', { enabled: true });
  await withServer({ configService }, async (base, app) => {
    const sent = useCapturingProvider(app, configService);
    const { created, outcome } = await bookedFlow(base);

    // Duplicate outcome reports (idempotent at the API) — trigger fires again,
    // but the delivery store suppresses any second notification.
    await post(base, '/api/v1/demo/outcome', outcome, bridgeAuth);
    await post(base, '/api/v1/demo/outcome', outcome, bridgeAuth);
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 1, 'exactly one customer confirmation, ever');
    const { message, context } = sent[0];
    assert.equal(context.notificationKey, `appointment-confirmation:${created.sessionId}`);
    assert.equal(message.recipient.email, 'ryan@example.com');
    assert.ok(message.rendered.subject.includes('Martinson & Beason, P.C.'));
    assert.ok(message.rendered.text.includes('Monday, July 20, 2026'));
    assert.equal(/cal\.com|microsoft|graph|outlook/i.test(message.rendered.subject + message.rendered.html), false);

    const record = await app.notifications.deliveryStore.get(`appointment-confirmation:${created.sessionId}`);
    assert.equal(record.status, 'sent');
  });
});

test('HTTP: failed and escalated outcomes never send a confirmation even when enabled', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'notifications', 'appointment-confirmation', { enabled: true });
  await withServer({ configService }, async (base, app) => {
    const sent = useCapturingProvider(app, configService);
    const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
    await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    await post(base, '/api/v1/demo/outcome', { sessionId: created.sessionId, status: 'failed', reason: 'No availability.' }, bridgeAuth);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0);
  });
});
