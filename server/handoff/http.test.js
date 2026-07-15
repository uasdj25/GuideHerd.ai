'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('./app');
const { fixedClock } = require('./clock');

const AT_1515 = Date.parse('2026-07-12T15:15:00Z');

function validRequest() {
  return {
    firmId: 'martinson-beason',
    caller: { fullName: 'David Jones', email: 'david.jones@example.com', phone: '+14044232676' },
    scheduling: {
      attorneyId: 'clay-martinson',
      practiceAreaId: 'personal-injury',
      consultationTypeId: 'initial-consultation',
    },
    handoff: { createdByUserId: 'receptionist-001', source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

/** Start the app on an ephemeral port, run `fn(base, app)`, then close. */
async function withServer(opts, fn) {
  const app = createApp(opts);
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('POST /api/v1/handoffs returns 201 with token and status', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await post(base, '/api/v1/handoffs', validRequest());
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'awaiting-transfer');
    assert.ok(body.sessionId);
    assert.match(body.handoffToken, /^gh_handoff_/);
    assert.equal(body.expiresInSeconds, 600);
  });
});

test('invalid create returns 400 with field details', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await post(base, '/api/v1/handoffs', { caller: {}, scheduling: {}, handoff: {} });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'validation_error');
    assert.ok(Array.isArray(body.error.details));
  });
});

test('malformed JSON returns 400', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await post(base, '/api/v1/handoffs', '{ not json');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'malformed_request');
  });
});

test('redeem returns 200 with the minimum scheduling context', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    assert.equal(res.status, 200);
    const ctx = await res.json();
    assert.equal(ctx.status, 'connected');
    assert.equal(ctx.callerName, 'David Jones');
    assert.equal(ctx.callerLastName, 'Jones');
    assert.equal('source' in ctx, false); // no receptionist/vendor leakage
  });
});

test('unknown token returns 404', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: 'gh_handoff_missing' });
    assert.equal(res.status, 404);
  });
});

test('blank token returns 400', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: '  ' });
    assert.equal(res.status, 400);
  });
});

test('second redemption returns 409', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    assert.equal(res.status, 409);
  });
});

test('expired token returns 410', async () => {
  const clock = fixedClock(AT_1515);
  await withServer({ clock }, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    clock.set(Date.parse('2026-07-12T15:25:00Z'));
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    assert.equal(res.status, 410);
  });
});

test('concurrent redemptions over HTTP yield exactly one 200', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', validRequest())).json();
    const statuses = await Promise.all(
      Array.from({ length: 15 }, () =>
        post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken }).then((r) => r.status),
      ),
    );
    assert.equal(statuses.filter((s) => s === 200).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 14);
  });
});

test('unknown route returns 404', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await fetch(base + '/api/v1/nope', { method: 'GET' });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_OPTS = {
  clock: fixedClock(AT_1515),
  corsAllowedOrigins: 'https://guideherd.ai,http://localhost:8080',
};

test('preflight from an allowed origin returns CORS headers', async () => {
  await withServer(CORS_OPTS, async (base) => {
    const res = await fetch(base + '/api/v1/handoffs', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://guideherd.ai',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://guideherd.ai');
    assert.equal(res.headers.get('access-control-allow-methods'), 'POST, GET, DELETE, OPTIONS');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
  });
});

test('preflight from a disallowed origin gets no CORS allow headers', async () => {
  await withServer(CORS_OPTS, async (base) => {
    const res = await fetch(base + '/api/v1/handoffs', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-methods'), null);
  });
});

test('POST from an allowed origin echoes that origin, never a wildcard', async () => {
  await withServer(CORS_OPTS, async (base) => {
    const res = await fetch(base + '/api/v1/handoffs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
      body: JSON.stringify(validRequest()),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('POST from a disallowed origin gets no CORS allow headers', async () => {
  await withServer(CORS_OPTS, async (base) => {
    const res = await fetch(base + '/api/v1/handoffs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(validRequest()),
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('a wildcard entry in the allowlist is ignored', async () => {
  await withServer({ clock: fixedClock(AT_1515), corsAllowedOrigins: '*' }, async (base) => {
    const res = await fetch(base + '/api/v1/handoffs', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
