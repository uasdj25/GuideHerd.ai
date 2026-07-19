'use strict';

/**
 * Security review pins (GitLab #39): login attempt limiting, API response
 * security headers, and HEAD support on the public probes. The wider
 * review's guarantees (authenticated operational APIs, bearer
 * enforcement, audit events, allowlisted telemetry, CSRF posture, XSS
 * escaping, org isolation) are pinned by their own suites; this file
 * covers what the review ADDED.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('./app');
const { fixedClock } = require('./clock');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const DEV_USERS = JSON.stringify([
  { key: 'dev-key-jane-0123456789abcdef', subject: 'jane-doe', organizationKey: 'martinson-beason', roles: ['receptionist'] },
]);

async function withServer(opts, fn) {
  const app = createApp({ clock: fixedClock(T0), devUsersJson: DEV_USERS, ...opts });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, app); } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const login = (base, credential, headers = {}) => fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ credential }),
});

test('login limiting: attempts are bounded per client window; the answer confirms nothing; other clients unaffected', async () => {
  await withServer({}, async (base, app) => {
    // Exhaust the window with wrong credentials from one address.
    let last;
    for (let i = 0; i < 30; i++) last = await login(base, 'wrong-credential-000000', { 'x-forwarded-for': '198.51.100.7' });
    assert.equal(last.status, 403, 'inside the window: ordinary uniform failures');

    const limited = await login(base, 'wrong-credential-000000', { 'x-forwarded-for': '198.51.100.7' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');

    // Even a VALID credential from the exhausted address is limited — the
    // limiter is credential-blind by design.
    assert.equal((await login(base, 'dev-key-jane-0123456789abcdef', { 'x-forwarded-for': '198.51.100.7' })).status, 429);

    // A different client is unaffected.
    assert.equal((await login(base, 'dev-key-jane-0123456789abcdef', { 'x-forwarded-for': '203.0.113.9' })).status, 200);

    // The window expires; the address recovers.
    app.clock.set(T0 + 10 * 60 * 1000);
    assert.equal((await login(base, 'dev-key-jane-0123456789abcdef', { 'x-forwarded-for': '198.51.100.7' })).status, 200);
  });
});

test('API responses carry the security headers on every path — success, error, and public', async () => {
  await withServer({}, async (base) => {
    for (const res of [
      await fetch(`${base}/healthz`),
      await fetch(`${base}/api/v1/operations/overview`), // 401
      await login(base, 'dev-key-jane-0123456789abcdef'),
    ]) {
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d+/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });
});

test('public probes answer HEAD (platform healthcheckers often use it)', async () => {
  await withServer({}, async (base) => {
    const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '', 'HEAD carries no body');
    assert.equal((await fetch(`${base}/readyz`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${base}/healthz`, { method: 'GET' })).status, 200, 'GET unchanged');
  });
});
