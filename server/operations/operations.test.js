'use strict';

/**
 * Operations Center tests (ADR-0014).
 *
 * Covers the Operations Contract queries, timeline generation, correlation
 * lookup, search, health, event ordering, empty states, authorization and
 * organization isolation over HTTP, and the guarantee that existing
 * workflows are unchanged. Deterministic: fixed clocks, no providers.
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
const { createInMemoryNotificationDeliveryStore } = require('../notifications/delivery-store');
const { createOperationsCenter, presentOperationalSession, STATUS_GROUPS } = require('./operations');
const { makeSession } = require('../operational/contract-suite');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

const DEV_USERS = JSON.stringify([
  { key: 'dev-key-ops-0123456789abcdef', subject: 'op-sam', displayName: 'Sam Ops', organizationKey: FIRM, roles: ['operator'] },
  { key: 'dev-key-jane-0123456789abcdef', subject: 'jane-doe', displayName: 'Jane Doe', organizationKey: FIRM, roles: ['receptionist'] },
  { key: 'dev-key-otherops-0123456789ab', subject: 'op-other', displayName: 'Other Ops', organizationKey: 'other-firm', roles: ['operator'] },
]);

// ── Unit: the Operations Contract over stores and events ────────────────────

function makeOps() {
  const clock = fixedClock(T0);
  const store = createInMemoryHandoffStore({ clock });
  const deliveries = createInMemoryNotificationDeliveryStore({ clock });
  const ops = createOperationsCenter({
    store,
    notificationDeliveryStore: deliveries,
    configService: null,
    clock,
    capabilities: [{ capability: 'notification-provider', check: () => 'not-configured' }],
  });
  return { clock, store, deliveries, ops };
}

test('operations: PII stripping — session views expose operational metadata only', () => {
  const { session } = makeSession({ phone: '+12565550100' });
  const presented = presentOperationalSession(session);
  const flat = JSON.stringify(presented);
  assert.equal(/Test Caller|caller@example\.com|0100|tokenHash|token_hash/i.test(flat), false, 'no caller PII or credentials');
  assert.equal(presented.sessionId, session.sessionId);
  assert.equal(presented.attorneyId, 'att-1');
  assert.equal(presented.createdAt, '2026-07-12T15:15:00.000Z');
});

test('operations: overview groups statuses; empty stores produce a well-formed empty state', async () => {
  const { store, ops } = makeOps();

  const empty = await ops.overview('org-a');
  assert.deepEqual(empty.sessions.groups, { pending: 0, active: 0, completed: 0, failed: 0 });
  assert.deepEqual(empty.notifications, {});
  assert.deepEqual(await ops.sessions('org-a'), []);
  assert.deepEqual(await ops.events('org-a'), []);
  assert.deepEqual((await ops.timeline('org-a', 'gh-none')).entries, []);
  assert.deepEqual(await ops.search('org-a', ''), { kind: 'empty', results: [] });

  const a = makeSession(); const b = makeSession(); const c = makeSession();
  await store.create(a.session); await store.create(b.session); await store.create(c.session);
  await store.connectEligible('org-a', { sessionId: b.session.sessionId });
  await store.applyOutcome(b.session.sessionId, { status: 'booked', appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' } });
  await store.cancel(c.session.sessionId, c.consoleTokenHash);

  const overview = await ops.overview('org-a');
  assert.deepEqual(overview.sessions.groups, { pending: 1, active: 0, completed: 1, failed: 1 });
  assert.deepEqual(Object.keys(STATUS_GROUPS), ['pending', 'active', 'completed', 'failed']);

  const completed = await ops.sessions('org-a', { group: 'completed' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].sessionId, b.session.sessionId);
});

test('operations: event feed is bounded, allowlisted, ordered, and organization-scoped', async () => {
  const { store, ops } = makeOps();
  const { session } = makeSession(); // org-a
  await store.create(session);

  ops.observe('request.failed', { severity: 'info', organizationKey: 'org-a', correlationId: 'gh-aaaaaabbbbbbccccccdddddd', callerName: 'LEAK ME', httpStatus: 404 });
  ops.observe('request.failed', { severity: 'error', organizationKey: 'org-b', correlationId: 'gh-other' });
  ops.observe('notification.delivered', { severity: 'info', sessionId: session.sessionId, correlationId: 'gh-aaaaaabbbbbbccccccdddddd' });
  ops.observe('internal.unexpected_error', { severity: 'error' }); // no org linkage: platform-internal

  const events = await ops.events('org-a', { limit: 10 });
  assert.equal(events.length, 2, 'org-b and unlinked events are invisible');
  assert.equal(events[0].name, 'notification.delivered', 'newest first');
  assert.equal(JSON.stringify(events).includes('LEAK ME'), false, 'unknown fields dropped by the allowlist');

  const errors = await ops.recentErrors('org-a');
  assert.equal(errors.length, 0, 'org-a has no error-severity events');

  // Bounded feed: the buffer never grows past its cap.
  for (let i = 0; i < 700; i++) ops.observe('request.failed', { severity: 'info', organizationKey: 'org-a' });
  assert.equal(ops.eventCount(), 500);
});

test('operations: the correlation timeline merges handoff lifecycle with events, chronologically', async () => {
  const { clock, store, ops } = makeOps();
  const { session } = makeSession();
  await store.create(session);
  clock.set(T0 + 30_000);
  await store.connectEligible('org-a', { sessionId: session.sessionId });
  ops.observe('conversation.connected', { severity: 'info', organizationKey: 'org-a', sessionId: session.sessionId, correlationId: 'gh-tl0000000000000000000001' });
  clock.set(T0 + 60_000);
  await store.applyOutcome(session.sessionId, { status: 'booked', appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' } });
  ops.observe('notification.suppressed', { severity: 'info', organizationKey: 'org-a', sessionId: session.sessionId, correlationId: 'gh-tl0000000000000000000001' });

  const { entries } = await ops.timeline('org-a', 'gh-tl0000000000000000000001');
  const labels = entries.map((e) => `${e.kind}:${e.label}`);
  assert.deepEqual(labels, [
    'handoff:handoff prepared',
    'conversation:conversation.connected',
    'handoff:caller connected',
    'handoff:outcome recorded: booked',
    'notification:notification.suppressed',
  ], 'chronological, combining lifecycle and events');
  assert.equal(JSON.stringify(entries).includes('caller@example.com'), false, 'no PII in timelines');

  // Cross-org: the same correlation ID reveals nothing to another org.
  assert.deepEqual((await ops.timeline('org-b', 'gh-tl0000000000000000000001')).entries, []);
});

test('operations: search resolves correlation IDs, session IDs, and attorneys — org-scoped', async () => {
  const { store, ops } = makeOps();
  const a = makeSession(); const other = makeSession({ firmId: 'org-b' });
  await store.create(a.session); await store.create(other.session);

  const bySession = await ops.search('org-a', a.session.sessionId);
  assert.equal(bySession.kind, 'session');
  const crossOrg = await ops.search('org-a', other.session.sessionId);
  assert.equal(crossOrg.kind, 'none', "another org's session id resolves to nothing");
  const byAttorney = await ops.search('org-a', 'att-1');
  assert.equal(byAttorney.kind, 'attorney');
  assert.equal(byAttorney.results.length, 1);
});

test('operations: notification views join to the organization through the session', async () => {
  const { store, deliveries, ops } = makeOps();
  const mine = makeSession(); const theirs = makeSession({ firmId: 'org-b' });
  await store.create(mine.session); await store.create(theirs.session);
  await deliveries.claim(`appointment-confirmation:${mine.session.sessionId}`);
  await deliveries.record(`appointment-confirmation:${mine.session.sessionId}`, 'failed');
  await deliveries.claim(`appointment-confirmation:${theirs.session.sessionId}`);
  await deliveries.record(`appointment-confirmation:${theirs.session.sessionId}`, 'sent');

  const records = await ops.notifications('org-a', { limit: 10 });
  assert.equal(records.length, 1, "org-b's notifications are invisible");
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].type, 'appointment-confirmation');

  const failed = await ops.notifications('org-a', { failedOnly: true });
  assert.equal(failed.length, 1);
});

test('operations: health reports GuideHerd capabilities and fails closed per capability', async () => {
  const { ops } = makeOps();
  const health = await ops.health();
  const byCapability = Object.fromEntries(health.map((h) => [h.capability, h.status]));
  assert.equal(byCapability['operational-store'], 'available');
  assert.equal(byCapability['configuration-store'], 'not-configured');
  assert.equal(byCapability['notification-provider'], 'not-configured');

  const broken = createOperationsCenter({
    store: { size: async () => { throw new Error('down'); }, get: async () => undefined },
    notificationDeliveryStore: { listRecent: async () => [] },
    clock: fixedClock(T0),
    capabilities: [{ capability: 'exploding', check: () => { throw new Error('boom'); } }],
  });
  const brokenHealth = await broken.health();
  const brokenBy = Object.fromEntries(brokenHealth.map((h) => [h.capability, h.status]));
  assert.equal(brokenBy['operational-store'], 'unavailable');
  assert.equal(brokenBy.exploding, 'unavailable');
});

// ── HTTP: authorization, isolation, end to end ──────────────────────────────

function configServiceWithFirms() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: 'America/New_York' });
  return configService;
}

async function withServer(opts, fn) {
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    configService: configServiceWithFirms(),
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

async function loginCookie(base, credential) {
  const res = await post(base, '/api/v1/auth/login', { credential });
  const match = (res.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/);
  return { cookie: `gh_session=${match ? match[1] : ''}` };
}

function createBody() {
  return {
    firmId: FIRM,
    caller: { fullName: 'Ops Test Caller', email: 'ops-caller@example.com', phone: '+12565550100' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

test('HTTP: operations routes require a session and the operations:read permission', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/operations/overview`)).status, 401, 'anonymous is rejected even with the console floor open');

    const receptionist = await loginCookie(base, 'dev-key-jane-0123456789abcdef');
    assert.equal((await fetch(`${base}/api/v1/operations/overview`, { headers: receptionist })).status, 403,
      'authenticated without operations:read is denied');

    const operator = await loginCookie(base, 'dev-key-ops-0123456789abcdef');
    const res = await fetch(`${base}/api/v1/operations/overview`, { headers: operator });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sessions && body.health, 'overview shape');
  });
});

test('HTTP: a full workflow appears in the dashboard — and only to its own organization', async () => {
  await withServer({}, async (base, app) => {
    const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
    const connect = await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
    const cid = connect.headers.get('x-guideherd-correlation-id');
    await post(base, '/api/v1/demo/outcome', {
      sessionId: created.sessionId, status: 'booked',
      appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' }, reason: 'Booked.',
    }, { authorization: `Bearer ${SECRET}` });

    const operator = await loginCookie(base, 'dev-key-ops-0123456789abcdef');

    const overview = await (await fetch(`${base}/api/v1/operations/overview`, { headers: operator })).json();
    assert.equal(overview.sessions.groups.completed, 1);

    const sessions = await (await fetch(`${base}/api/v1/operations/sessions?group=completed`, { headers: operator })).json();
    assert.equal(sessions.sessions[0].sessionId, created.sessionId);
    assert.equal(JSON.stringify(sessions).includes('ops-caller@example.com'), false, 'no caller PII in dashboard data');

    const timeline = await (await fetch(`${base}/api/v1/operations/timeline/${cid}`, { headers: operator })).json();
    const kinds = new Set(timeline.entries.map((e) => e.kind));
    assert.ok(kinds.has('handoff') && kinds.has('conversation'), 'timeline combines lifecycle and conversation events');

    const search = await (await fetch(`${base}/api/v1/operations/search?q=${cid}`, { headers: operator })).json();
    assert.equal(search.kind, 'correlation');
    assert.ok(search.results.length > 0);

    // Organization isolation over HTTP: the other firm's operator sees nothing.
    const outsider = await loginCookie(base, 'dev-key-otherops-0123456789ab');
    const theirOverview = await (await fetch(`${base}/api/v1/operations/overview`, { headers: outsider })).json();
    assert.deepEqual(theirOverview.sessions.groups, { pending: 0, active: 0, completed: 0, failed: 0 });
    const theirTimeline = await (await fetch(`${base}/api/v1/operations/timeline/${cid}`, { headers: outsider })).json();
    assert.deepEqual(theirTimeline.entries, [], 'a correlation ID leaks nothing across organizations');

    // Health over HTTP.
    const health = await (await fetch(`${base}/api/v1/operations/health`, { headers: operator })).json();
    const byCapability = Object.fromEntries(health.health.map((h) => [h.capability, h.status]));
    assert.equal(byCapability['operational-store'], 'available');
    assert.equal(byCapability['configuration-store'], 'available');
    assert.equal(byCapability['scheduling-provider'], 'not-integrated');
    assert.equal(byCapability['user-authentication'], 'available');
    assert.equal(byCapability['service-identity'], 'available');
    // Configuration authority (ADR-0022): without a boot-time seed this
    // composition is live-authoritative.
    assert.equal(byCapability['configuration-authority'], 'live');
  });
});

test('HTTP: a seed-managed deployment reports itself on the health surface (ADR-0022)', async () => {
  const authority = { mode: 'seed-managed', seedOnBoot: true, lastBootImport: 'imported' };
  await withServer({ configurationAuthority: authority }, async (base) => {
    const operator = await loginCookie(base, 'dev-key-ops-0123456789abcdef');
    const health = await (await fetch(`${base}/api/v1/operations/health`, { headers: operator })).json();
    const byCapability = Object.fromEntries(health.health.map((h) => [h.capability, h.status]));
    assert.equal(byCapability['configuration-authority'], 'seed-managed');
  });
});

// ── Health probes and the bounded health report (#38) ───────────────────────

test('healthReport: parallel bounded checks, rollup, and readiness', async (t) => {
  const clock = fixedClock(T0);
  const base = () => ({
    notificationDeliveryStore: createInMemoryNotificationDeliveryStore({ clock }),
    configService: null,
    clock,
  });

  await t.test('healthy: everything answers; dark states do not degrade', async () => {
    const ops = createOperationsCenter({
      ...base(),
      store: createInMemoryHandoffStore({ clock }),
      capabilities: [
        { capability: 'notification-provider', check: () => 'not-configured' },
        { capability: 'scheduling-provider', check: () => 'not-integrated' },
      ],
    });
    const report = await ops.healthReport();
    assert.equal(report.status, 'healthy', 'not-configured/not-integrated are deliberate dark states');
    assert.equal(report.checkedAt, '2026-07-12T15:15:00.000Z');
    assert.equal(await ops.ready(), true);
  });

  await t.test('degraded: a non-required capability failing or THROWING', async () => {
    const ops = createOperationsCenter({
      ...base(),
      store: createInMemoryHandoffStore({ clock }),
      capabilities: [{ capability: 'workflow-engine', check: () => { throw new Error('boom'); } }],
    });
    const report = await ops.healthReport();
    assert.equal(report.status, 'degraded');
    assert.equal(report.health.find((h) => h.capability === 'workflow-engine').status, 'unavailable');
    assert.equal(await ops.ready(), true, 'a degraded capability does not fail readiness');
  });

  await t.test('unavailable: a required store failing fails readiness too', async () => {
    const broken = createInMemoryHandoffStore({ clock });
    broken.size = async () => { throw new Error('store down'); };
    const ops = createOperationsCenter({ ...base(), store: broken, capabilities: [] });
    const report = await ops.healthReport();
    assert.equal(report.status, 'unavailable');
    assert.equal(report.health.find((h) => h.capability === 'operational-store').status, 'unavailable');
    assert.equal(await ops.ready(), false);
  });

  await t.test('a HANGING check reports unavailable within the timeout instead of hanging', async () => {
    const hung = createInMemoryHandoffStore({ clock });
    hung.size = () => new Promise(() => {}); // never resolves
    const ops = createOperationsCenter({
      ...base(), store: hung, capabilities: [], healthCheckTimeoutMs: 50,
    });
    const started = Date.now();
    const report = await ops.healthReport();
    assert.ok(Date.now() - started < 1000, 'bounded by the timeout, not the hang');
    assert.equal(report.status, 'unavailable');
    assert.equal(await ops.ready(), false);
  });
});

test('HTTP: /healthz and /readyz are public, minimal, and leak nothing (#38)', async () => {
  await withServer({}, async (base) => {
    const live = await fetch(`${base}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' }, 'liveness is zero-information');

    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' }, 'readiness is one word — no capability detail');

    // The authenticated detail surface still requires a session.
    assert.equal((await fetch(`${base}/api/v1/operations/health`)).status, 401);
  });
});

test('HTTP: /readyz answers 503 when a required store is down (#38)', async () => {
  const clock = fixedClock(T0);
  const broken = createInMemoryHandoffStore({ clock });
  broken.size = async () => { throw new Error('store down'); };
  await withServer({ handoffStore: broken }, async (base) => {
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'unavailable' });
    // Liveness is unaffected: the process itself is up.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test('HTTP: the operations health report carries the rollup and timestamp (#38)', async () => {
  await withServer({}, async (base) => {
    const operator = await loginCookie(base, 'dev-key-ops-0123456789abcdef');
    const report = await (await fetch(`${base}/api/v1/operations/health`, { headers: operator })).json();
    assert.equal(report.status, 'healthy');
    assert.ok(report.checkedAt);
    assert.ok(Array.isArray(report.health) && report.health.length > 0, 'pre-#38 shape preserved');
    const overview = await (await fetch(`${base}/api/v1/operations/overview`, { headers: operator })).json();
    assert.equal(overview.healthStatus, 'healthy');
  });
});

test('HTTP: existing workflows are unchanged by the Operations Center', async () => {
  await withServer({}, async (base) => {
    // Anonymous console (default floor), bridge auth, capability tokens —
    // all exactly as before.
    assert.equal((await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`)).status, 200);
    const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
    const statusRes = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { authorization: `Bearer ${created.consoleToken}` },
    });
    assert.equal(statusRes.status, 200);
    assert.equal((await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` })).status, 200);
  });
});
