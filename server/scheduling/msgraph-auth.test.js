'use strict';

/**
 * Microsoft Graph calendar auth (GitLab #83): fail-closed configuration,
 * consent-revocation classification, token caching with skew,
 * single-flight acquisition, and secret hygiene — all against a mocked
 * token endpoint. Live behavior is #95's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixedClock } = require('../handoff/clock');
const { createTelemetry } = require('../telemetry/telemetry');
const {
  createGraphCalendarAuth, graphCalendarConnectionState, EXPIRY_SKEW_MS,
} = require('./msgraph-auth');
const {
  CalendarProviderNotConfiguredError, CalendarUnavailableError,
} = require('./calendar-provider');

const T0 = Date.parse('2026-08-30T15:00:00Z');
const ENV = {
  MS_TENANT_ID: 'tenant-id-for-tests',
  MS_CLIENT_ID: 'client-id-for-tests',
  MS_CLIENT_SECRET: 'secret-value-for-tests-only',
};

function mockTokenEndpoint(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = typeof script === 'function' ? script(calls.length) : script;
    if (step instanceof Error) throw step;
    return {
      ok: step.status === 200,
      status: step.status,
      async json() { return step.body; },
    };
  };
  return { calls, fetchImpl };
}

const okToken = (token = 'tok-1', expiresIn = 3600) => ({
  status: 200, body: { access_token: token, expires_in: expiresIn },
});

test('graph auth: missing credentials fail closed with ZERO identity-provider calls', async () => {
  const { calls, fetchImpl } = mockTokenEndpoint(okToken());
  const auth = createGraphCalendarAuth({ env: {}, fetchImpl });
  assert.equal(auth.configured, false);
  await assert.rejects(auth.getToken(), CalendarProviderNotConfiguredError);
  assert.equal(calls.length, 0);
  assert.deepEqual(graphCalendarConnectionState({ env: {} }).missing,
    ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET']);
  assert.equal(graphCalendarConnectionState({ env: ENV }).configured, true);
});

test('graph auth: tokens cache until the skewed expiry, then refresh', async () => {
  const clock = fixedClock(T0);
  const { calls, fetchImpl } = mockTokenEndpoint((n) => okToken(`tok-${n}`, 3600));
  const auth = createGraphCalendarAuth({ env: ENV, fetchImpl, clock });
  assert.equal(await auth.getToken(), 'tok-1');
  assert.equal(await auth.getToken(), 'tok-1', 'cached');
  assert.equal(calls.length, 1);
  // Just before the skew boundary: still cached.
  clock.advance(3600_000 - EXPIRY_SKEW_MS - 1000);
  assert.equal(await auth.getToken(), 'tok-1');
  // Past it: refreshed.
  clock.advance(2000);
  assert.equal(await auth.getToken(), 'tok-2');
  assert.equal(calls.length, 2);
});

test('graph auth: concurrent acquisition is single-flight', async () => {
  const { calls, fetchImpl } = mockTokenEndpoint((n) => okToken(`tok-${n}`));
  const auth = createGraphCalendarAuth({ env: ENV, fetchImpl, clock: fixedClock(T0) });
  const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
  assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1']);
  assert.equal(calls.length, 1, 'one request serves every concurrent caller');
});

test('graph auth: revoked consent / bad credentials classify as CONFIGURATION with loud telemetry', async () => {
  for (const status of [400, 401, 403]) {
    const lines = [];
    const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
    const { fetchImpl } = mockTokenEndpoint({ status, body: { error: 'invalid_client' } });
    const auth = createGraphCalendarAuth({ env: ENV, fetchImpl, telemetry, clock: fixedClock(T0) });
    await assert.rejects(auth.getToken(), (err) => err instanceof CalendarProviderNotConfiguredError
      && err.phase === 'token');
    assert.ok(lines.some((l) => l.event === 'guideherd.provider.authentication_failed'),
      `telemetry for ${status}`);
  }
});

test('graph auth: transient token trouble is calendar_unavailable, tagged as token-phase', async () => {
  const cases = [
    [{ status: 429, body: {} }, 'token_http_429'],
    [{ status: 503, body: {} }, 'token_http_503'],
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'token_timeout'],
    [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'token_network_failure'],
    [{ status: 200, body: { nope: true } }, 'token_malformed_response'],
  ];
  for (const [script, detail] of cases) {
    const { fetchImpl } = mockTokenEndpoint(script);
    const auth = createGraphCalendarAuth({ env: ENV, fetchImpl, clock: fixedClock(T0) });
    await assert.rejects(auth.getToken(), (err) => err instanceof CalendarUnavailableError
      && err.detail === detail && err.phase === 'token', detail);
  }
});

test('graph auth: invalidate() forces exactly one fresh acquisition', async () => {
  const { calls, fetchImpl } = mockTokenEndpoint((n) => okToken(`tok-${n}`));
  const auth = createGraphCalendarAuth({ env: ENV, fetchImpl, clock: fixedClock(T0) });
  await auth.getToken();
  auth.invalidate();
  assert.equal(await auth.getToken(), 'tok-2');
  assert.equal(calls.length, 2);
});

test('graph auth: the secret value never appears in errors or telemetry', async () => {
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
  const { fetchImpl } = mockTokenEndpoint({ status: 401, body: {} });
  const auth = createGraphCalendarAuth({ env: ENV, fetchImpl, telemetry, clock: fixedClock(T0) });
  let thrown;
  try {
    await auth.getToken();
  } catch (err) {
    thrown = err;
  }
  const surfaces = JSON.stringify({ message: thrown.message, stack: thrown.stack, lines });
  assert.ok(!surfaces.includes(ENV.MS_CLIENT_SECRET), 'no secret value anywhere');
  assert.ok(!surfaces.includes(ENV.MS_TENANT_ID), 'no tenant id leakage either');
});
