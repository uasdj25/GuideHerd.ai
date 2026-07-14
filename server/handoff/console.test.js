'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('./app');
const { fixedClock } = require('./clock');
const { SessionStatus } = require('./status');

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
    body: JSON.stringify(body),
  });
}

function withBearer(token) {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

async function createSession(base) {
  return (await post(base, '/api/v1/handoffs', validRequest())).json();
}

// ---------------------------------------------------------------------------
// Create — dual credentials
// ---------------------------------------------------------------------------

test('create returns distinct handoff and console tokens', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const body = await createSession(base);
    assert.match(body.handoffToken, /^gh_handoff_/);
    assert.match(body.consoleToken, /^gh_console_/);
    assert.notEqual(body.handoffToken, body.consoleToken);
  });
});

test('store keeps only hashes — raw tokens are not in the store', async () => {
  const app = createApp({ clock: fixedClock(AT_1515) });
  const { response } = app.service.create(validRequest());
  const session = app.store.get(response.sessionId);

  assert.ok(session.tokenHash, 'handoff token hash stored');
  assert.ok(session.consoleTokenHash, 'console token hash stored');
  assert.notEqual(session.tokenHash, response.handoffToken);
  assert.notEqual(session.consoleTokenHash, response.consoleToken);
  // Raw token material never appears anywhere in the stored record.
  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes(response.handoffToken), false);
  assert.equal(serialized.includes(response.consoleToken), false);
});

test('neither raw token is written to the request log', async () => {
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
      const body = await createSession(base);
      await fetch(`${base}/api/v1/handoffs/${body.sessionId}`, { headers: withBearer(body.consoleToken) });
      await post(base, '/api/v1/handoffs/redeem', { handoffToken: body.handoffToken });
      const all = logged.join('\n');
      assert.equal(all.includes(body.handoffToken), false, 'handoff token not logged');
      assert.equal(all.includes(body.consoleToken), false, 'console token not logged');
    });
  } finally {
    console.log = original;
  }
});

// ---------------------------------------------------------------------------
// Status endpoint
// ---------------------------------------------------------------------------

test('GET status with a valid console token returns operational metadata only', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'expiresAt', 'sessionId', 'status']);
    assert.equal(body.status, 'awaiting-transfer');
    // No caller context, no credentials.
    const raw = JSON.stringify(body);
    for (const leak of ['David Jones', '+14044232676', 'clay-martinson', 'personal-injury', 'initial-consultation', 'receptionist-001', 'gh_handoff_', 'gh_console_']) {
      assert.equal(raw.includes(leak), false, `must not leak: ${leak}`);
    }
  });
});

test('GET status without authorization returns 401', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`);
    assert.equal(res.status, 401);
  });
});

test('GET status with malformed authorization returns 401', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    for (const header of ['Token abc', 'Bearer', 'Bearer  ', created.consoleToken]) {
      const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
        headers: { authorization: header },
      });
      assert.equal(res.status, 401, `malformed header "${header}" -> 401`);
    }
  });
});

test('GET status with an invalid console token returns 403', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer('gh_console_wrongwrongwrongwrongwrongwrongwrong'),
    });
    assert.equal(res.status, 403);
  });
});

test('the handoff token cannot be used as a console credential', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.handoffToken),
    });
    assert.equal(res.status, 403);
  });
});

test('GET status for an unknown session returns 404', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/does-not-exist`, {
      headers: withBearer(created.consoleToken),
    });
    assert.equal(res.status, 404);
  });
});

test('status becomes connected after handoff redemption', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    });
    const body = await res.json();
    assert.equal(body.status, 'connected');
  });
});

test('expired session reports status expired with no caller context', async () => {
  const clock = fixedClock(AT_1515);
  await withServer({ clock }, async (base) => {
    const created = await createSession(base);
    clock.set(Date.parse('2026-07-12T15:25:00Z'));
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'expired');
    assert.equal(JSON.stringify(body).includes('David Jones'), false);
  });
});

test('cancelled session reports status cancelled', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    });
    assert.equal((await res.json()).status, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// Cancel endpoint
// ---------------------------------------------------------------------------

test('awaiting-transfer session cancels successfully with minimal body', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['sessionId', 'status']);
    assert.equal(body.status, 'cancelled');
    assert.equal(JSON.stringify(body).includes('David Jones'), false);
  });
});

test('cancellation invalidates the handoff token for redemption', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error.code, 'token_cancelled');
  });
});

test('cancel without authorization returns 401; with wrong token 403', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res401 = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, { method: 'DELETE' });
    assert.equal(res401.status, 401);
    const res403 = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer('gh_console_not_the_right_token_at_all_here'),
    });
    assert.equal(res403.status, 403);
    // Session remains active after failed cancels.
    const status = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    });
    assert.equal((await status.json()).status, 'awaiting-transfer');
  });
});

test('connected session cannot be cancelled (409)', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    assert.equal(res.status, 409);
  });
});

test('repeat cancel is idempotent (200 cancelled)', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const first = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    const second = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, 'cancelled');
  });
});

test('expired session cannot be cancelled (410)', async () => {
  const clock = fixedClock(AT_1515);
  await withServer({ clock }, async (base) => {
    const created = await createSession(base);
    clock.set(Date.parse('2026-07-12T15:25:01Z'));
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    assert.equal(res.status, 410);
  });
});

test('concurrent cancel/redeem attempts settle into exactly one terminal outcome', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () =>
        fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
          method: 'DELETE', headers: withBearer(created.consoleToken),
        }).then((r) => r.json().then((b) => ({ kind: 'cancel', status: r.status, body: b })))),
      ...Array.from({ length: 8 }, () =>
        post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken })
          .then((r) => r.json().then((b) => ({ kind: 'redeem', status: r.status, body: b })))),
    ]);

    const redeemWins = results.filter((r) => r.kind === 'redeem' && r.status === 200).length;
    const cancelWins = results.filter((r) => r.kind === 'cancel' && r.status === 200).length > 0
      && results.some((r) => r.kind === 'cancel' && r.body.status === 'cancelled');

    // Exactly one terminal state: either the redeem won (0 or 1 times, never
    // more) or the cancels won — never both.
    assert.ok(redeemWins <= 1, 'redeem can win at most once');
    if (redeemWins === 1) {
      assert.equal(results.some((r) => r.kind === 'cancel' && r.status === 200), false,
        'if redeem won, no cancel may report success');
    } else {
      assert.ok(cancelWins, 'if redeem lost, cancellation must have won');
    }

    // Final status agrees with the winner.
    const final = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    })).json();
    assert.equal(final.status, redeemWins === 1 ? 'connected' : 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// CORS for console methods
// ---------------------------------------------------------------------------

const CORS_OPTS = {
  clock: fixedClock(AT_1515),
  corsAllowedOrigins: 'https://guideherd.ai,http://localhost:8080',
};

test('GET and DELETE preflights succeed with Authorization allowed', async () => {
  await withServer(CORS_OPTS, async (base) => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/api/v1/handoffs/some-id`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://guideherd.ai',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://guideherd.ai');
      assert.ok(res.headers.get('access-control-allow-methods').includes(method));
      assert.ok(res.headers.get('access-control-allow-headers').includes('Authorization'));
    }
  });
});

test('GET status from an allowed origin carries the allow-origin header', async () => {
  await withServer(CORS_OPTS, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { ...withBearer(created.consoleToken), origin: 'http://localhost:8080' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  });
});

test('disallowed origin gets no allow-origin on console endpoints', async () => {
  await withServer(CORS_OPTS, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { ...withBearer(created.consoleToken), origin: 'https://evil.example' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('wildcard CORS configuration remains rejected', async () => {
  await withServer({ clock: fixedClock(AT_1515), corsAllowedOrigins: '*' }, async (base) => {
    const created = await createSession(base);
    const res = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { ...withBearer(created.consoleToken), origin: 'https://anything.example' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

// ---------------------------------------------------------------------------
// Compatibility — existing create/redeem clients keep working
// ---------------------------------------------------------------------------

test('existing create/redeem flow is unchanged apart from the added consoleToken field', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    assert.deepEqual(
      Object.keys(created).sort(),
      ['consoleToken', 'createdAt', 'expiresAt', 'expiresInSeconds', 'handoffToken', 'sessionId', 'status'],
    );
    const redeemed = await (await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken })).json();
    assert.equal(redeemed.status, 'connected');
    assert.equal(redeemed.callerName, 'David Jones');
    assert.equal('consoleToken' in redeemed, false, 'redeem response gains no new fields');
  });
});

// Ensure the session status transition on redeem still matches the enum.
test('redeemed session status matches SessionStatus.CONNECTED', async () => {
  const app = createApp({ clock: fixedClock(AT_1515) });
  const { handoffToken, response } = app.service.create(validRequest());
  app.service.redeem(handoffToken);
  assert.equal(app.store.get(response.sessionId).status, SessionStatus.CONNECTED);
});

// ---------------------------------------------------------------------------
// Cancellation credential contract (exact semantics)
// ---------------------------------------------------------------------------

test('post-expiry: cancelled session still reads status cancelled, but repeat cancel is 410', async () => {
  const clock = fixedClock(AT_1515);
  await withServer({ clock }, async (base) => {
    const created = await createSession(base);
    // Cancel while active
    const first = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    assert.equal(first.status, 200);

    // Move past the session's original expiry
    clock.set(Date.parse('2026-07-12T15:26:00Z'));

    // Console token still reads the terminal status…
    const read = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).status, 'cancelled');

    // …but the idempotent-cancel window has closed.
    const repeat = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: withBearer(created.consoleToken),
    });
    assert.equal(repeat.status, 410);
    assert.equal((await repeat.json()).error.code, 'session_expired');

    // And the handoff token stays dead.
    const redeem = await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    assert.equal(redeem.status, 410);
  });
});

test('console token can never cause a transition out of a terminal state', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken }); // -> connected
    // Repeated cancels and reads leave the state untouched.
    await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, { method: 'DELETE', headers: withBearer(created.consoleToken) });
    await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, { headers: withBearer(created.consoleToken) });
    const final = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: withBearer(created.consoleToken),
    })).json();
    assert.equal(final.status, 'connected');
  });
});

// ---------------------------------------------------------------------------
// Session ID entropy
// ---------------------------------------------------------------------------

test('session IDs are v4 UUIDs from a CSPRNG: well-formed, unique, non-sequential', () => {
  const app = createApp({ clock: fixedClock(AT_1515) });
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = [];
  for (let i = 0; i < 1000; i++) {
    const { response } = app.service.create(validRequest());
    assert.match(response.sessionId, V4, 'session id is a v4 UUID (122 random bits)');
    ids.push(response.sessionId);
  }
  assert.equal(new Set(ids).size, 1000, 'all ids unique');
  // Non-sequential: adjacent ids must not share a long common prefix the way
  // counters or timestamps would.
  let maxCommonPrefix = 0;
  for (let i = 1; i < ids.length; i++) {
    let j = 0;
    while (j < ids[i].length && ids[i][j] === ids[i - 1][j]) j++;
    if (j > maxCommonPrefix) maxCommonPrefix = j;
  }
  assert.ok(maxCommonPrefix < 8, `adjacent ids share at most ${maxCommonPrefix} leading chars`);
});
