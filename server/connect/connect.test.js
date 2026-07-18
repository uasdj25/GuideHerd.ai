'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { createAdapterRegistry } = require('./adapter');
const { createElevenLabsAdapter } = require('./elevenlabs-adapter');
const { createConversationEvents } = require('./events');
const { resolveProviderKey, DEFAULT_PROVIDER, SETTINGS_NAMESPACE, SETTINGS_KEY } = require('./provider-config');
const { ProviderUnavailableError } = require('./errors');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');

const AT_1515 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

// ── Shared fixtures ─────────────────────────────────────────────────────────

function validRequest(overrides = {}) {
  return {
    firmId: FIRM,
    caller: { fullName: 'Ryan Scoggins', email: 'ryan@example.com', phone: '+12565551212' },
    scheduling: {
      attorneyId: 'clay-martinson',
      practiceAreaId: 'personal-injury',
      consultationTypeId: 'initial-consultation',
    },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
    ...overrides,
  };
}

function flatBooked(sessionId) {
  return {
    sessionId,
    status: 'booked',
    appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
    reason: 'Initial consultation booked.',
  };
}

function nestedBooked(sessionId) {
  return {
    sessionId,
    outcome: {
      status: 'booked',
      appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
      schedulingSummary: 'Initial consultation booked.',
    },
  };
}

function fakeMailer() {
  const sends = [];
  return {
    sends,
    enabled: true,
    async sendSummary(message) {
      sends.push(message);
      return { status: 'sent' };
    },
  };
}

/** Build a real (in-memory) Configuration Store with the firm seeded. */
function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  return configService;
}

async function withServer(opts, fn) {
  const app = createApp({ demoBridgeSecret: SECRET, mailer: fakeMailer(), clock: fixedClock(AT_1515), ...opts });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app);
  } finally {
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

// ── Adapter registry ────────────────────────────────────────────────────────

test('registry resolves a registered adapter and rejects unknown providers loudly', () => {
  const registry = createAdapterRegistry();
  const adapter = registry.register(createElevenLabsAdapter());
  assert.equal(registry.resolve('elevenlabs'), adapter);
  assert.deepEqual(registry.keys(), ['elevenlabs']);
  assert.throws(() => registry.resolve('teams'), ProviderUnavailableError);
  assert.throws(() => registry.register({}), TypeError);
});

// ── ElevenLabs adapter translation ──────────────────────────────────────────

test('elevenlabs adapter: connect bodies are provider ceremony and always ignored', () => {
  const adapter = createElevenLabsAdapter();
  for (const body of [undefined, {}, { request: 'connect' }, { anything: ['at', 'all'] }]) {
    assert.deepEqual(adapter.translateConnect(body), {});
  }
});

test('elevenlabs adapter: flat and nested outcome dialects translate identically', () => {
  const adapter = createElevenLabsAdapter();
  const fromFlat = adapter.translateOutcome(flatBooked('s-1'));
  const fromNested = adapter.translateOutcome(nestedBooked('s-1'));
  assert.deepEqual(fromFlat, fromNested);
  assert.equal(fromFlat.outcome.schedulingSummary, 'Initial consultation booked.');
});

test('elevenlabs adapter: canonical validation is not loosened by translation', () => {
  const adapter = createElevenLabsAdapter();
  // Mixed formats, provider payload smuggling, and invalid times all reject.
  assert.throws(() => adapter.translateOutcome({ ...flatBooked('s-1'), outcome: { status: 'booked' } }));
  assert.throws(() => adapter.translateOutcome({ sessionId: 's-1', status: 'booked', transcript: 'hello' }));
  assert.throws(() => adapter.translateOutcome({
    sessionId: 's-1',
    status: 'booked',
    appointment: { startsAt: '2026-07-20', timezone: 'America/Chicago' },
  }));
});

// ── Provider configuration resolution ───────────────────────────────────────

test('provider resolution defaults to elevenlabs without a config store or setting', () => {
  assert.equal(resolveProviderKey(null, FIRM), DEFAULT_PROVIDER);

  const configService = configServiceWithFirm(); // org exists, setting unset
  assert.equal(resolveProviderKey(configService, FIRM), DEFAULT_PROVIDER);
  assert.equal(resolveProviderKey(configService, 'unknown-org'), DEFAULT_PROVIDER);
});

test('provider resolution honors the connect/conversation-provider setting', () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: 'teams' });
  assert.equal(resolveProviderKey(configService, FIRM), 'teams');

  // Malformed values fall back to the default rather than crashing.
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: '' });
  assert.equal(resolveProviderKey(configService, FIRM), DEFAULT_PROVIDER);
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, 'elevenlabs');
  assert.equal(resolveProviderKey(configService, FIRM), DEFAULT_PROVIDER);
});

test('an explicitly configured but unregistered provider fails loudly with 503', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: 'ringcentral' });
  await withServer({ configService }, async (base) => {
    await post(base, '/api/v1/handoffs', validRequest());
    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'conversation_provider_unavailable');
  });
});

test('the configured elevenlabs provider serves the demo exactly as the default does', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, {
    provider: 'elevenlabs',
    agentId: 'agent_public_reference_only',
  });
  await withServer({ configService }, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    const connect = await post(base, '/api/v1/demo/connect', { request: 'connect' }, bridgeAuth);
    assert.equal(connect.status, 200);
    assert.equal((await connect.json()).sessionId, created.sessionId);
    const outcome = await post(base, '/api/v1/demo/outcome', flatBooked(created.sessionId), bridgeAuth);
    assert.equal(outcome.status, 200);
    assert.equal((await outcome.json()).status, 'booked');
  });
});

// ── Conversation events ─────────────────────────────────────────────────────

test('the conversation lifecycle emits provider-neutral events with no secrets or caller PII', async () => {
  await withServer({}, async (base, app) => {
    const seen = [];
    app.events.on('conversation.connected', (p) => seen.push(['connected', p]));
    app.events.on('conversation.completed', (p) => seen.push(['completed', p]));

    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    await post(base, '/api/v1/demo/outcome', flatBooked(created.sessionId), bridgeAuth);

    assert.equal(seen.length, 2);
    const [, connected] = seen[0];
    assert.deepEqual(connected, {
      sessionId: created.sessionId,
      firmId: FIRM,
      provider: 'elevenlabs',
      correlation: 'exactly-one-eligible', // signal KEY only, never a value
      at: '2026-07-12T15:15:00.000Z',
    });
    const [, completed] = seen[1];
    assert.deepEqual(completed, {
      sessionId: created.sessionId,
      firmId: FIRM,
      provider: 'elevenlabs',
      status: 'booked',
      summaryDelivery: 'sent',
      at: '2026-07-12T15:15:00.000Z',
    });

    // Payloads carry identifiers only — never tokens, secrets, or contact details.
    const raw = JSON.stringify(seen);
    assert.equal(/gh_handoff_|gh_console_|tokenHash|Bearer|example\.com|Scoggins|\+1256/i.test(raw), false);
  });
});

test('an idempotent duplicate outcome does not emit a second completion event', async () => {
  await withServer({}, async (base, app) => {
    let completions = 0;
    app.events.on('conversation.completed', () => { completions += 1; });

    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    await post(base, '/api/v1/demo/outcome', flatBooked(created.sessionId), bridgeAuth);
    const dup = await post(base, '/api/v1/demo/outcome', flatBooked(created.sessionId), bridgeAuth);
    assert.equal(dup.status, 200, 'duplicate remains idempotent at the API');
    assert.equal(completions, 1, 'one completion event for one completed conversation');
  });
});

test('a throwing event subscriber never breaks the conversation flow', async () => {
  const logged = [];
  const original = console.log;
  console.log = (l) => logged.push(String(l));
  try {
    await withServer({}, async (base, app) => {
      app.events.on('conversation.connected', () => { throw new Error('subscriber exploded'); });
      const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
      const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
      assert.equal(res.status, 200, 'connect succeeds despite the failing subscriber');
      assert.equal((await res.json()).sessionId, created.sessionId);
    });
    assert.ok(logged.some((l) => l.includes('Conversation event subscriber failed.')));
  } finally {
    console.log = original;
  }
});

test('unsubscribe stops delivery', () => {
  const events = createConversationEvents();
  let calls = 0;
  const off = events.on('conversation.connected', () => { calls += 1; });
  events.emit('conversation.connected', {});
  off();
  events.emit('conversation.connected', {});
  assert.equal(calls, 1);
});
