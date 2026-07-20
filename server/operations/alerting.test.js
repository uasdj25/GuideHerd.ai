'use strict';

/**
 * Failure alerting tests (GitLab #68): exactly one alert per
 * condition-window (structural, via the notification claim machine),
 * threshold aggregation for failed outcomes, baseline-then-edge
 * capability degradation with observable recovery, default-off recipient
 * configuration, loud telemetry independent of delivery, no feedback
 * loop, and no caller PII anywhere. Deterministic: fixed clocks.
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
const { createNotificationProviderRegistry } = require('../notifications/contract');
const { createNotificationService } = require('../notifications/service');
const { createInMemoryNotificationDeliveryStore } = require('../notifications/delivery-store');
const { createAlertingService, DEFAULT_WINDOW_MS, DEFAULT_FAILED_OUTCOME_THRESHOLD } = require('./alerting');
require('../notifications/alert-notification'); // renderer under test

const T0 = Date.parse('2026-07-12T15:15:00Z');
const FIRM = 'martinson-beason';
const RECIPIENT = 'ops-admin@example-firm.test';

function harness({ enabled = true } = {}) {
  const clock = fixedClock(T0);
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  if (enabled) {
    configService.settings.set(FIRM, 'operations', 'alerts', { enabled: true, recipient: RECIPIENT });
  }

  const sent = [];
  const registry = createNotificationProviderRegistry();
  registry.register({
    providerKey: 'capture',
    async deliver({ rendered, recipient }) {
      sent.push({ rendered, recipient });
      return { status: 'sent' };
    },
  });
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock });
  const notifications = createNotificationService({
    registry,
    deliveryStore: createInMemoryNotificationDeliveryStore({ clock }),
    configService,
    telemetry,
    typeProviders: { 'operational-alert': 'capture' },
  });

  let healthStatuses = [{ capability: 'notification-provider', status: 'available' }];
  const alerting = createAlertingService({
    notifications,
    configService,
    clock,
    telemetry,
    healthReport: async () => ({ health: healthStatuses.map((h) => ({ ...h })) }),
  });
  return {
    clock, configService, alerting, sent, lines,
    setHealth: (statuses) => { healthStatuses = statuses; },
  };
}

test('alerting: an exhausted delivery raises EXACTLY ONE alert per window; the next window may alert again', async () => {
  const h = harness();
  const failure = { organizationKey: FIRM, notificationType: 'consultation-summary', sessionId: 'mock-session-1' };

  h.alerting.observe('notification.delivery_failed', failure);
  await new Promise((r) => setImmediate(r)); // fire-and-forget settles
  assert.equal(h.sent.length, 1, 'one alert email');
  assert.equal(h.sent[0].recipient.email, RECIPIENT);
  assert.match(h.sent[0].rendered.subject, /notification-delivery-failed/);

  for (let i = 0; i < 5; i++) h.alerting.observe('notification.delivery_failed', failure);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 1, 'repeats in the same window are structurally suppressed — no storm');

  h.clock.set(T0 + DEFAULT_WINDOW_MS);
  h.alerting.observe('notification.delivery_failed', failure);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 2, 'a persisting condition alerts once per window');

  // Loud telemetry fired for every raise, independent of delivery dedup.
  assert.ok(h.lines.filter((l) => l.event === 'guideherd.alert.raised').length >= 2);
});

test('alerting: no feedback loop, and configuration-state failures belong to the capability condition', async () => {
  const h = harness();
  h.alerting.observe('notification.delivery_failed', { organizationKey: FIRM, notificationType: 'operational-alert' });
  h.alerting.observe('notification.delivery_failed', { organizationKey: FIRM, code: 'provider_not_configured', notificationType: 'consultation-summary' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 0, 'own-type and not-configured failures never self-alert');
});

test('alerting: failed handoff outcomes aggregate to a threshold — one blip never alerts', async () => {
  const h = harness();
  const consumer = h.alerting.outboxConsumer();
  assert.equal(consumer.consumer, 'failure-alerting');
  const failedEvent = (n) => ({ organizationKey: FIRM, sessionId: `s-${n}`, payload: { status: 'failed' } });

  await consumer.handle({ organizationKey: FIRM, sessionId: 's-ok', payload: { status: 'booked' } });
  await consumer.handle(failedEvent(1));
  await consumer.handle(failedEvent(2));
  assert.equal(h.sent.length, 0, 'below threshold: silence');

  await consumer.handle(failedEvent(3));
  assert.equal(h.sent.length, 1, `the ${DEFAULT_FAILED_OUTCOME_THRESHOLD}rd failure in the window alerts`);
  assert.match(h.sent[0].rendered.subject, /handoff-outcomes-failing/);

  await consumer.handle(failedEvent(4));
  await consumer.handle(failedEvent(5));
  assert.equal(h.sent.length, 1, 'further failures in the window stay aggregated');

  h.clock.set(T0 + DEFAULT_WINDOW_MS);
  await consumer.handle(failedEvent(6));
  await consumer.handle(failedEvent(7));
  await consumer.handle(failedEvent(8));
  assert.equal(h.sent.length, 2, 'a fresh window aggregates afresh');
});

test('alerting: capability degradation is baseline-then-edge, with observable recovery', async () => {
  const h = harness();

  // First look records the baseline — even a dark boot never alerts.
  h.setHealth([{ capability: 'notification-provider', status: 'not-configured' }]);
  await h.alerting.evaluate();
  assert.equal(h.sent.length, 0, 'baseline is silent');

  // Recovery then runtime degradation: the EDGE alerts, once.
  h.setHealth([{ capability: 'notification-provider', status: 'available' }]);
  await h.alerting.evaluate();
  h.setHealth([{ capability: 'notification-provider', status: 'unavailable' }]);
  await h.alerting.evaluate();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].rendered.subject, /capability-degraded:notification-provider/);

  await h.alerting.evaluate();
  await h.alerting.evaluate();
  assert.equal(h.sent.length, 1, 'a persisting degradation does not repeat');

  h.setHealth([{ capability: 'notification-provider', status: 'available' }]);
  await h.alerting.evaluate();
  assert.ok(h.lines.some((l) => l.event === 'guideherd.alert.recovered'
    && l.code === 'capability-recovered:notification-provider'), 'recovery is observable');
});

test('alerting: DEFAULT OFF — without an enabled recipient nothing emails, but telemetry stays loud', async () => {
  const h = harness({ enabled: false });
  h.alerting.observe('notification.delivery_failed', { organizationKey: FIRM, notificationType: 'consultation-summary' });
  await new Promise((r) => setImmediate(r));
  const consumer = h.alerting.outboxConsumer();
  for (let i = 1; i <= 3; i++) await consumer.handle({ organizationKey: FIRM, sessionId: `s-${i}`, payload: { status: 'failed' } });
  assert.equal(h.sent.length, 0, 'no recipient, no email');
  assert.ok(h.lines.filter((l) => l.event === 'guideherd.alert.raised').length >= 2, 'still loud');
});

test('alerting: no caller PII in alert content or telemetry; renderer escapes', async () => {
  const h = harness();
  h.alerting.observe('notification.delivery_failed', { organizationKey: FIRM, notificationType: 'consultation-summary', sessionId: 'mock-session-1' });
  await new Promise((r) => setImmediate(r));
  const flat = JSON.stringify(h.sent) + JSON.stringify(h.lines);
  assert.equal(/Test Caller|caller@example\.com|\+1256|fullName|phone/i.test(flat), false);

  const { renderNotificationRequest } = require('../notifications/templates');
  const rendered = renderNotificationRequest({
    type: 'operational-alert',
    model: { condition: '<script>x</script>', count: 2 },
  }, null);
  assert.equal(rendered.html.includes('<script>'), false, 'HTML-escaped regardless of source');
});

test('alerting: domain validation — enabling requires a recipient; malformed input degrades dark', () => {
  const { validateDomain, readDomain } = require('../configuration/framework');
  assert.equal(validateDomain('operational-alerts', { enabled: true, recipient: 'ops@firm.example' }).ok, true);
  assert.equal(validateDomain('operational-alerts', { enabled: true }).ok, false, 'enabled without recipient refused');
  assert.equal(validateDomain('operational-alerts', { enabled: true, recipient: 'not-an-email' }).ok, false);
  assert.equal(validateDomain('operational-alerts', { enabled: true, recipient: 'x@y.z', extra: 1 }).ok, false);

  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'F', timezone: 'UTC' });
  const { value } = readDomain(configService, 'operational-alerts', FIRM);
  assert.deepEqual(value, { enabled: false, recipient: null }, 'dark default');
});

test('HTTP: the failure-alerting capability reports not-configured until an organization opts in', async () => {
  const DEV_USERS = JSON.stringify([
    { key: 'dev-key-ops-0123456789abcdef', subject: 'op-sam', organizationKey: FIRM, roles: ['operator'] },
  ]);
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'F', timezone: 'UTC' });

  const app = createApp({ clock: fixedClock(T0), configService, devUsersJson: DEV_USERS });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'dev-key-ops-0123456789abcdef' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1];
    const auth = { cookie: `gh_session=${cookie}` };

    const before = await (await fetch(`${base}/api/v1/operations/health`, { headers: auth })).json();
    const cap = (h) => Object.fromEntries(h.health.map((x) => [x.capability, x.status]));
    assert.equal(cap(before)['failure-alerting'], 'not-configured');

    configService.settings.set(FIRM, 'operations', 'alerts', { enabled: true, recipient: RECIPIENT });
    const after = await (await fetch(`${base}/api/v1/operations/health`, { headers: auth })).json();
    assert.equal(cap(after)['failure-alerting'], 'available', 'flips live when an organization opts in');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('alerting #68 review: a raised alert surfaces LIVE in the Operations Center feed (recentErrors) — the ephemeral surface, not a durable history', async () => {
  // Composed app so the real observe → Operations feed wiring is exercised.
  const DEV_USERS = JSON.stringify([
    { key: 'dev-key-ops-0123456789abcdef', subject: 'op-sam', organizationKey: FIRM, roles: ['operator'] },
  ]);
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'F', timezone: 'UTC' });
  // Enabled, but delivery will fail — the point is what an admin can SEE.
  configService.settings.set(FIRM, 'operations', 'alerts', { enabled: true, recipient: RECIPIENT });

  const app = createApp({ clock: fixedClock(T0), configService, devUsersJson: DEV_USERS });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Drive the exhausted-delivery condition through the real telemetry seam.
    app.alerting.observe('notification.delivery_failed', {
      organizationKey: FIRM, notificationType: 'consultation-summary', sessionId: 'mock-session-1',
    });
    await new Promise((r) => setImmediate(r));

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'dev-key-ops-0123456789abcdef' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1];
    const errors = await (await fetch(`${base}/api/v1/operations/errors`, { headers: { cookie: `gh_session=${cookie}` } })).json();

    const raised = errors.events.find((e) => e.name === 'guideherd.alert.raised' || e.name === 'alert.raised');
    assert.ok(raised, 'the raised alert is visible LIVE in the Operations Center recent-errors feed');
    // Honest boundary (documented + follow-up proposed): this feed is the
    // ADR-0014 v1 EPHEMERAL feed — it does not survive a restart, and there
    // is no dedicated durable alert-history surface. No caller PII either.
    assert.equal(JSON.stringify(errors).includes('caller@example.com'), false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
