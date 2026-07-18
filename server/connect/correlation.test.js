'use strict';

/**
 * Correlation Engine tests.
 *
 * Unit tests drive the engine against the in-memory reference repository
 * (the shared contract suite already proves connectEligible behaves
 * identically in PostgreSQL). HTTP tests exercise the full path — provider
 * dialect → Conversation Adapter → neutral ConnectIntent → Correlation
 * Engine — through a synthetic provider adapter, proving the engine is
 * reachable without a single line of provider-specific logic in Core.
 *
 * All data is synthetic; all time comes from the fixed clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { createInMemoryHandoffStore } = require('../handoff/store');
const { SessionStatus } = require('../handoff/status');
const { makeSession } = require('../operational/contract-suite');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { SETTINGS_NAMESPACE, SETTINGS_KEY } = require('./provider-config');
const {
  createCorrelationEngine,
  defaultSignals,
  sessionIdSignal,
  callerPhoneSignal,
  BASELINE,
} = require('./correlation');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

function makeEngine({ signals } = {}) {
  const clock = fixedClock(T0);
  const store = createInMemoryHandoffStore({ clock });
  const engine = createCorrelationEngine(signals ? { store, signals } : { store });
  return { clock, store, engine };
}

// ── Engine semantics ────────────────────────────────────────────────────────

test('correlation: an empty intent is the exactly-one-eligible baseline — no regression', async () => {
  const { store, engine } = makeEngine();

  await assert.rejects(() => engine.correlate('org-a', {}), (e) => e.code === 'no_prepared_session');

  const a = makeSession();
  await store.create(a.session);
  const one = await engine.correlate('org-a', {});
  assert.equal(one.session.sessionId, a.session.sessionId);
  assert.equal(one.matchedBy, BASELINE);

  const b = makeSession();
  const c = makeSession();
  await store.create(b.session);
  await store.create(c.session);
  await assert.rejects(() => engine.correlate('org-a', {}), (e) => e.code === 'ambiguous_prepared_sessions');
});

test('correlation: caller phone selects the right session among several prepared callers', async () => {
  const { store, engine } = makeEngine();
  const a = makeSession({ phone: '+12565550101' });
  const b = makeSession({ phone: '+12565550102' });
  const c = makeSession({ phone: '+12565550103' });
  for (const s of [a, b, c]) await store.create(s.session);

  // The provider reports a formatted national number; the engine normalizes.
  const result = await engine.correlate('org-a', { callerPhone: '(256) 555-0102' });
  assert.equal(result.session.sessionId, b.session.sessionId);
  assert.equal(result.matchedBy, 'caller-phone');
  assert.equal((await store.get(a.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
  assert.equal((await store.get(c.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
});

test('correlation: an explicit session id outranks a caller phone pointing elsewhere', async () => {
  const { store, engine } = makeEngine();
  const a = makeSession({ phone: '+12565550101' });
  const b = makeSession({ phone: '+12565550102' });
  await store.create(a.session);
  await store.create(b.session);

  const result = await engine.correlate('org-a', {
    sessionId: a.session.sessionId,
    callerPhone: '+12565550102', // would match b — must lose to the explicit id
  });
  assert.equal(result.session.sessionId, a.session.sessionId);
  assert.equal(result.matchedBy, 'session-id');
  assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
});

test('correlation: an explicit session id that matches nothing FAILS — it never falls through to weaker signals', async () => {
  const { store, engine } = makeEngine();
  const a = makeSession({ phone: '+12565550101' });
  await store.create(a.session);

  await assert.rejects(
    () => engine.correlate('org-a', { sessionId: 'no-such-session', callerPhone: '+12565550101' }),
    (e) => e.code === 'no_prepared_session',
    'falling back could connect the wrong caller',
  );
  assert.equal((await store.get(a.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
});

test('correlation: a phone that narrows to nothing defers — one prepared caller still connects (current behavior)', async () => {
  const { store, engine } = makeEngine();
  const only = makeSession({ phone: null }); // prepared without a phone on file
  await store.create(only.session);

  const result = await engine.correlate('org-a', { callerPhone: '+12565550199' });
  assert.equal(result.session.sessionId, only.session.sessionId);
  assert.equal(result.matchedBy, BASELINE);
});

test('correlation: a phone that narrows to nothing among SEVERAL prepared callers is ambiguous — never a guess', async () => {
  const { store, engine } = makeEngine();
  const a = makeSession({ phone: null });
  const b = makeSession({ phone: null });
  await store.create(a.session);
  await store.create(b.session);

  await assert.rejects(
    () => engine.correlate('org-a', { callerPhone: '+12565550199' }),
    (e) => e.code === 'ambiguous_prepared_sessions',
  );
  assert.equal((await store.get(a.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
  assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
});

test('correlation: duplicate phones within one organization are ambiguous', async () => {
  const { store, engine } = makeEngine();
  const a = makeSession({ phone: '+12565550101' });
  const b = makeSession({ phone: '+12565550101' });
  await store.create(a.session);
  await store.create(b.session);

  await assert.rejects(
    () => engine.correlate('org-a', { callerPhone: '+12565550101' }),
    (e) => e.code === 'ambiguous_prepared_sessions',
  );
});

test('correlation: matching is tenant-scoped — the same phone in two organizations never collides', async () => {
  const { store, engine } = makeEngine();
  const a = makeSession({ firmId: 'org-a', phone: '+12565550101' });
  const b = makeSession({ firmId: 'org-b', phone: '+12565550101' });
  await store.create(a.session);
  await store.create(b.session);

  const inA = await engine.correlate('org-a', { callerPhone: '+12565550101' });
  assert.equal(inA.session.sessionId, a.session.sessionId);
  const inB = await engine.correlate('org-b', { callerPhone: '+12565550101' });
  assert.equal(inB.session.sessionId, b.session.sessionId);
});

test('correlation: an unnormalizable caller phone contributes no signal', async () => {
  const { store, engine } = makeEngine();
  const only = makeSession({ phone: '+12565550101' });
  await store.create(only.session);

  const result = await engine.correlate('org-a', { callerPhone: 'anonymous' });
  assert.equal(result.session.sessionId, only.session.sessionId);
  assert.equal(result.matchedBy, BASELINE, 'garbage is an absent signal, never a guess');
});

// ── Extensibility ───────────────────────────────────────────────────────────

test('correlation: a future signal plugs in at its priority without modifying existing logic', async () => {
  // A synthetic "receptionist workstation" signal: workstation -> session id,
  // resolved from operational knowledge the future feature would own. The
  // engine, the existing signals, and the repositories are untouched.
  const workstationToSession = new Map();
  const workstationSignal = {
    key: 'workstation',
    authoritative: false,
    extract: (intent) => (typeof intent.workstationId === 'string' ? intent.workstationId : null),
    criteria: (value) => ({ sessionId: workstationToSession.get(value) ?? 'no-match' }),
  };
  const { store, engine } = makeEngine({
    signals: [sessionIdSignal(), workstationSignal, callerPhoneSignal()],
  });

  const a = makeSession({ phone: '+12565550101' });
  const b = makeSession({ phone: '+12565550102' });
  await store.create(a.session);
  await store.create(b.session);
  workstationToSession.set('desk-7', b.session.sessionId);

  const result = await engine.correlate('org-a', { workstationId: 'desk-7' });
  assert.equal(result.session.sessionId, b.session.sessionId);
  assert.equal(result.matchedBy, 'workstation');

  // An unknown workstation defers to weaker signals, then the baseline —
  // which connects the one remaining prepared caller, exactly as today.
  const fallback = await engine.correlate('org-a', { workstationId: 'desk-9' });
  assert.equal(fallback.session.sessionId, a.session.sessionId);
  assert.equal(fallback.matchedBy, BASELINE);

  // With several prepared callers and no narrowing signal: explicit ambiguity.
  const c = makeSession({ phone: '+12565550103' });
  const d = makeSession({ phone: '+12565550104' });
  await store.create(c.session);
  await store.create(d.session);
  await assert.rejects(
    () => engine.correlate('org-a', { workstationId: 'desk-9' }),
    (e) => e.code === 'ambiguous_prepared_sessions',
    'no narrowing + several prepared = explicit ambiguity',
  );
});

test('correlation: malformed signals are rejected at construction', () => {
  const clock = fixedClock(T0);
  const store = createInMemoryHandoffStore({ clock });
  assert.throws(() => createCorrelationEngine({ store, signals: [{ key: 'x' }] }), TypeError);
  assert.throws(() => createCorrelationEngine({ store, signals: [null] }), TypeError);
  const engine = createCorrelationEngine({ store });
  assert.deepEqual(engine.signalKeys(), ['session-id', 'caller-phone']);
  assert.deepEqual(defaultSignals().map((s) => s.key), ['session-id', 'caller-phone']);
});

// ── Full provider-neutral path over HTTP ────────────────────────────────────

/**
 * A synthetic voice provider whose dialect reports caller metadata. It
 * proves the metadata path end to end with ZERO provider-specific logic in
 * Core: the adapter translates its dialect into the neutral ConnectIntent
 * and the Correlation Engine does the rest.
 */
function createTestVoiceAdapter() {
  return {
    providerKey: 'test-voice',
    translateConnect(rawBody) {
      if (rawBody === null || typeof rawBody !== 'object') return {};
      const intent = {};
      if (typeof rawBody.guideherd_session_id === 'string') intent.sessionId = rawBody.guideherd_session_id;
      if (typeof rawBody.caller_id === 'string') intent.callerPhone = rawBody.caller_id;
      if (typeof rawBody.conversation_ref === 'string') intent.providerConversationId = rawBody.conversation_ref;
      return intent;
    },
    translateOutcome(rawBody) {
      const { normalizeOutcome } = require('../handoff/demo-bridge');
      return normalizeOutcome(rawBody);
    },
  };
}

function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  return configService;
}

async function withTestVoiceServer(fn) {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: 'test-voice' });
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    configService,
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
  });
  app.adapters.register(createTestVoiceAdapter());
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app);
  } finally {
    // Deterministic teardown: destroy any keep-alive sockets so no test's
    // connections (or the shared fetch pool's idle sockets) can outlive its
    // server and interact with a later test's port assignment.
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

function prepareCaller(base, fullName, phone) {
  return post(base, '/api/v1/handoffs', {
    firmId: FIRM,
    caller: { fullName, email: `${fullName.toLowerCase().replace(/\s+/g, '.')}@example.com`, phone },
    scheduling: { attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  }).then((r) => r.json());
}

test('HTTP: provider caller metadata connects the right one of several prepared callers', async () => {
  await withTestVoiceServer(async (base, app) => {
    const events = [];
    app.events.on('conversation.connected', (p) => events.push(p));

    await prepareCaller(base, 'First Caller', '+12565550101');
    const second = await prepareCaller(base, 'Second Caller', '(256) 555-0102');

    const res = await post(base, '/api/v1/demo/connect', { caller_id: '+1 256 555 0102' }, bridgeAuth);
    assert.equal(res.status, 200);
    const context = await res.json();
    assert.equal(context.sessionId, second.sessionId);
    assert.equal(context.caller.fullName, 'Second Caller');

    assert.equal(events.length, 1);
    assert.equal(events[0].correlation, 'caller-phone', 'event names the signal, never its value');
    assert.equal(events[0].provider, 'test-voice');
    assert.equal(JSON.stringify(events).includes('0102'), false, 'no phone digits in events');
  });
});

test('HTTP: an explicit GuideHerd session id connects that exact session', async () => {
  await withTestVoiceServer(async (base) => {
    await prepareCaller(base, 'First Caller', '+12565550101');
    const second = await prepareCaller(base, 'Second Caller', '+12565550102');

    const res = await post(base, '/api/v1/demo/connect', { guideherd_session_id: second.sessionId }, bridgeAuth);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sessionId, second.sessionId);
  });
});

test('HTTP: ambiguity is an explicit 409, and no session is consumed', async () => {
  await withTestVoiceServer(async (base) => {
    const a = await prepareCaller(base, 'Caller One', '+12565550101');
    const b = await prepareCaller(base, 'Caller Two', '+12565550101'); // same number

    const res = await post(base, '/api/v1/demo/connect', { caller_id: '+12565550101' }, bridgeAuth);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'ambiguous_prepared_sessions');

    // Neither session was consumed: each remains individually connectable.
    for (const created of [a, b]) {
      const statusRes = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
        headers: { authorization: `Bearer ${created.consoleToken}` },
      });
      assert.equal((await statusRes.json()).status, 'awaiting-transfer');
    }
  });
});

test('HTTP: no prepared session remains an explicit 404', async () => {
  await withTestVoiceServer(async (base) => {
    const res = await post(base, '/api/v1/demo/connect', { caller_id: '+12565550101' }, bridgeAuth);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'no_prepared_session');
  });
});

test('HTTP: concurrent transfers for different callers each connect their own session', async () => {
  await withTestVoiceServer(async (base) => {
    const first = await prepareCaller(base, 'First Caller', '+12565550101');
    const second = await prepareCaller(base, 'Second Caller', '+12565550102');

    const [r1, r2] = await Promise.all([
      post(base, '/api/v1/demo/connect', { caller_id: '+12565550101' }, bridgeAuth),
      post(base, '/api/v1/demo/connect', { caller_id: '+12565550102' }, bridgeAuth),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal((await r1.json()).sessionId, first.sessionId);
    assert.equal((await r2.json()).sessionId, second.sessionId);
  });
});
