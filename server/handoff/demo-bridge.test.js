'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('./app');
const { fixedClock } = require('./clock');
const { buildConsultationSummary, renderSummaryHtml, summarySubject } = require('./summary');
const { createMailer } = require('./mailer');

const AT_1515 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';

function validRequest(overrides = {}) {
  return {
    firmId: 'martinson-beason',
    caller: { fullName: 'Ryan Scoggins', email: 'Ryan.Scoggins@Example.COM ', phone: '+12565551212' },
    scheduling: {
      attorneyId: 'clay-martinson',
      practiceAreaId: 'personal-injury',
      consultationTypeId: 'initial-consultation',
      existingClient: false,
    },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
    ...overrides,
  };
}

function bookedOutcome(sessionId) {
  return {
    sessionId,
    outcome: {
      status: 'booked',
      appointment: {
        startsAt: '2026-07-20T15:00:00-05:00',
        timezone: 'America/Chicago',
        attorneyId: 'clay-martinson',
        consultationTypeId: 'initial-consultation',
      },
      schedulingSummary: 'Initial consultation booked.',
      unresolvedQuestions: [],
      escalationRequired: false,
    },
  };
}

/** A mailer test double that records sends without any network. */
function fakeMailer(behavior = {}) {
  const sends = [];
  let failures = behavior.failFirst ? 1 : 0;
  return {
    sends,
    enabled: true,
    async sendSummary(message) {
      sends.push(message);
      if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
      if (failures > 0) { failures -= 1; return { status: 'failed' }; }
      if (behavior.alwaysFail) return { status: 'failed' };
      return { status: 'sent' };
    },
  };
}

async function withServer(opts, fn) {
  const app = createApp({ demoBridgeSecret: SECRET, mailer: fakeMailer(), ...opts });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app);
  } finally {
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

const bridgeAuth = { authorization: `Bearer ${SECRET}` };

async function createSession(base, overrides) {
  return (await post(base, '/api/v1/handoffs', validRequest(overrides))).json();
}

// ---------------------------------------------------------------------------
// Required email
// ---------------------------------------------------------------------------

test('missing and malformed emails are rejected; legitimate ones accepted', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const cases = [
      [undefined, 400], ['', 400], ['   ', 400], ['not-an-email', 400],
      ['a@b', 400], ['two words@example.com', 400], ['@example.com', 400],
      ['ryan@example.com', 201],
      ['first.last+tag@sub.example.co.uk', 201],
      ["o'brien@example.com", 201],
    ];
    for (const [email, expected] of cases) {
      const req = validRequest();
      if (email === undefined) delete req.caller.email; else req.caller.email = email;
      const res = await post(base, '/api/v1/handoffs', req);
      assert.equal(res.status, expected, `email ${JSON.stringify(email)} -> ${expected}`);
    }
  });
});

test('email is trimmed, local part preserved exactly, domain lowercased', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base); // fixture: 'Ryan.Scoggins@Example.COM '
    const ctx = await (await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken })).json();
    assert.equal(ctx.callerEmail, 'Ryan.Scoggins@example.com');
  });
});

test('email appears in redemption but never in status or cancellation responses', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const status = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { authorization: `Bearer ${created.consoleToken}` },
    })).json();
    assert.equal(JSON.stringify(status).toLowerCase().includes('example.com'), false, 'status leaks email');
    const cancel = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${created.consoleToken}` },
    })).json();
    assert.equal(JSON.stringify(cancel).toLowerCase().includes('example.com'), false, 'cancel leaks email');
  });
});

test('email is not written to the request log', async () => {
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
      await createSession(base);
      assert.equal(logged.join('\n').toLowerCase().includes('example.com'), false);
    });
  } finally {
    console.log = original;
  }
});

// ---------------------------------------------------------------------------
// Demo connect — authorization
// ---------------------------------------------------------------------------

test('connect: missing auth 401, malformed 401, wrong secret 403, unconfigured 503', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    assert.equal((await post(base, '/api/v1/demo/connect', {})).status, 401);
    assert.equal((await post(base, '/api/v1/demo/connect', {}, { authorization: 'Token x' })).status, 401);
    assert.equal((await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer wrong' })).status, 403);
  });
  await withServer({ clock: fixedClock(AT_1515), demoBridgeSecret: undefined }, async (base) => {
    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'demo_bridge_not_configured');
  });
});

test('connect responses carry no-store and never any CORS allow-origin', async () => {
  await withServer({ clock: fixedClock(AT_1515), corsAllowedOrigins: 'https://guideherd.ai' }, async (base) => {
    await createSession(base);
    const res = await fetch(`${base}/api/v1/demo/connect`, {
      method: 'POST',
      headers: { ...bridgeAuth, origin: 'https://guideherd.ai' }, // even an allowlisted origin
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'demo endpoints must not get browser CORS');
  });
});

// ---------------------------------------------------------------------------
// Demo connect — selection semantics
// ---------------------------------------------------------------------------

test('exactly one eligible session connects with full GuideHerd context', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 200);
    const ctx = await res.json();
    assert.deepEqual(ctx, {
      sessionId: created.sessionId,
      status: 'connected',
      caller: {
        fullName: 'Ryan Scoggins',
        email: 'Ryan.Scoggins@example.com',
        phone: '+12565551212',
        existingClient: false,
      },
      scheduling: {
        attorneyId: 'clay-martinson',
        practiceAreaId: 'personal-injury',
        consultationTypeId: 'initial-consultation',
      },
      firmId: 'martinson-beason',
    });
    // No credentials anywhere in the response.
    const raw = JSON.stringify(ctx);
    assert.equal(/gh_handoff_|gh_console_|tokenHash|consoleTokenHash/.test(raw), false);
  });
});

test('zero eligible sessions -> 404 no_prepared_session', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'no_prepared_session');
  });
});

test('multiple eligible sessions -> 409 ambiguity and redeems none', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const a = await createSession(base);
    const b = await createSession(base);
    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'ambiguous_prepared_sessions');
    // Neither session was redeemed.
    for (const s of [a, b]) {
      const st = await (await fetch(`${base}/api/v1/handoffs/${s.sessionId}`, {
        headers: { authorization: `Bearer ${s.consoleToken}` },
      })).json();
      assert.equal(st.status, 'awaiting-transfer');
    }
  });
});

test('expired and cancelled sessions are not eligible', async () => {
  const clock = fixedClock(AT_1515);
  await withServer({ clock }, async (base) => {
    const stale = await createSession(base);
    clock.set(Date.parse('2026-07-12T15:26:00Z')); // stale expires
    const cancelled = await createSession(base);
    await fetch(`${base}/api/v1/handoffs/${cancelled.sessionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${cancelled.consoleToken}` },
    });
    const fresh = await createSession(base);

    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 200);
    const ctx = await res.json();
    assert.equal(ctx.sessionId, fresh.sessionId, 'only the fresh session is eligible');
  });
});

test('concurrent connect attempts produce exactly one success', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    await createSession(base);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post(base, '/api/v1/demo/connect', {}, bridgeAuth).then((r) => r.status)),
    );
    assert.equal(results.filter((s) => s === 200).length, 1);
    assert.equal(results.filter((s) => s === 404).length, 9); // already connected -> no longer eligible
  });
});

test('handoff-token redemption remains operational alongside the bridge', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base);
    const res = await post(base, '/api/v1/handoffs/redeem', { handoffToken: created.handoffToken });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).callerEmail, 'Ryan.Scoggins@example.com');
  });
});

// ---------------------------------------------------------------------------
// Outcome — transitions and validation
// ---------------------------------------------------------------------------

async function connectOne(base) {
  const created = await createSession(base);
  await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
  return created;
}

test('booked, failed, and escalated transitions from connected', async () => {
  for (const status of ['booked', 'failed', 'escalated']) {
    await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
      const created = await connectOne(base);
      const body = status === 'booked'
        ? bookedOutcome(created.sessionId)
        : { sessionId: created.sessionId, outcome: { status, schedulingSummary: 'x' } };
      const res = await post(base, '/api/v1/demo/outcome', body, bridgeAuth);
      assert.equal(res.status, 200, `${status} accepted`);
      const st = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
        headers: { authorization: `Bearer ${created.consoleToken}` },
      })).json();
      assert.equal(st.status, status);
    });
  }
});

test('booked requires appointment startsAt and timezone', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await connectOne(base);
    for (const appointment of [undefined, {}, { startsAt: '2026-07-20T15:00:00-05:00' }, { timezone: 'America/Chicago' }, { startsAt: 'not-a-date', timezone: 'America/Chicago' }]) {
      const res = await post(base, '/api/v1/demo/outcome', {
        sessionId: created.sessionId,
        outcome: { status: 'booked', ...(appointment !== undefined ? { appointment } : {}) },
      }, bridgeAuth);
      assert.equal(res.status, 400, `appointment ${JSON.stringify(appointment)} rejected`);
    }
  });
});

test('outcome on awaiting-transfer session is rejected without mutation', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await createSession(base); // never connected
    const res = await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'invalid_outcome_state');
    const st = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { authorization: `Bearer ${created.consoleToken}` },
    })).json();
    assert.equal(st.status, 'awaiting-transfer', 'session not mutated');
  });
});

test('cancelled and expired sessions never accept outcomes', async () => {
  const clock = fixedClock(AT_1515);
  await withServer({ clock }, async (base) => {
    const cancelled = await createSession(base);
    await fetch(`${base}/api/v1/handoffs/${cancelled.sessionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${cancelled.consoleToken}` },
    });
    assert.equal((await post(base, '/api/v1/demo/outcome', bookedOutcome(cancelled.sessionId), bridgeAuth)).status, 409);

    const expiring = await createSession(base);
    clock.set(Date.parse('2026-07-12T15:40:00Z'));
    assert.equal((await post(base, '/api/v1/demo/outcome', bookedOutcome(expiring.sessionId), bridgeAuth)).status, 409);
  });
});

test('duplicate identical outcome is idempotent; conflicting outcome is rejected', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await connectOne(base);
    const first = await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth);
    assert.equal(first.status, 200);
    const dup = await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth);
    assert.equal(dup.status, 200, 'identical duplicate idempotent');
    assert.equal((await dup.json()).status, 'booked');

    const conflict = await post(base, '/api/v1/demo/outcome', {
      sessionId: created.sessionId, outcome: { status: 'failed' },
    }, bridgeAuth);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'outcome_conflict');
  });
});

test('provider payloads, transcripts, and unknown fields are rejected', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await connectOne(base);
    const bad = [
      { sessionId: created.sessionId, outcome: { status: 'failed' }, calendarEvent: { uid: 'x' } },
      { sessionId: created.sessionId, outcome: { status: 'failed', transcript: 'caller said...' } },
      { sessionId: created.sessionId, outcome: { status: 'failed', providerEventId: 'evt_123' } },
      { sessionId: created.sessionId, outcome: { status: 'booked', appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago', bookingUid: 'cal_abc' } } },
      { sessionId: created.sessionId, outcome: { status: 'failed', unresolvedQuestions: Array(11).fill('q') } },
      { sessionId: created.sessionId, outcome: { status: 'failed', schedulingSummary: 'x'.repeat(501) } },
    ];
    for (const body of bad) {
      const res = await post(base, '/api/v1/demo/outcome', body, bridgeAuth);
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(body).slice(0, 60)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Consultation Summary model + rendering
// ---------------------------------------------------------------------------

test('summary model maps trusted fields exactly and invents nothing', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base, app) => {
    const created = await connectOne(base);
    await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth);
    const session = app.store.get(created.sessionId);
    const model = buildConsultationSummary(session);
    assert.deepEqual(model, {
      caller: { fullName: 'Ryan Scoggins', email: 'Ryan.Scoggins@example.com', phone: '+12565551212', existingClient: false },
      request: { attorneyId: 'clay-martinson', practiceAreaId: 'personal-injury', consultationTypeId: 'initial-consultation' },
      outcome: { status: 'booked', appointmentStartsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
      notes: { schedulingSummary: 'Initial consultation booked.', unresolvedQuestions: [], escalationRequired: false },
      timestamps: {
        createdAt: '2026-07-12T15:15:00.000Z',
        connectedAt: '2026-07-12T15:15:00.000Z',
        completedAt: '2026-07-12T15:15:00.000Z',
      },
    });
    assert.equal(summarySubject(model), 'GuideHerd Consultation Summary — Ryan Scoggins — July 20, 2026');
  });
});

test('summary HTML escapes user content and contains no internals or vendors', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base, app) => {
    const created = await createSession(base, {
      caller: { fullName: '<script>alert(1)</script> & "Quotes"', email: 'x@example.com' },
    });
    await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    await post(base, '/api/v1/demo/outcome', {
      sessionId: created.sessionId,
      outcome: { status: 'escalated', schedulingSummary: '<img src=x onerror=1>', unresolvedQuestions: ['<b>q</b>'] },
    }, bridgeAuth);
    const html = renderSummaryHtml(buildConsultationSummary(app.store.get(created.sessionId)));
    assert.equal(html.includes('<script>alert'), false, 'script escaped');
    assert.equal(html.includes('<img src=x'), false, 'img escaped');
    assert.equal(html.includes('<b>q</b>'), false, 'question escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
    assert.equal(/gh_handoff_|gh_console_|tokenHash|sessionId|ElevenLabs|Cal\.com|Microsoft|Graph/i.test(html), false, 'no internals/vendors');
    assert.ok(html.includes('Human assistance required'));
    assert.ok(html.includes('Powered by GuideHerd'.toUpperCase().slice(0, 7)) || /powered by guideherd/i.test(html));
  });
});

test('summary handles missing optional fields', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base, app) => {
    const created = await createSession(base, {
      caller: { fullName: 'Min Caller', email: 'min@example.com' },
      scheduling: { attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    });
    await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    await post(base, '/api/v1/demo/outcome', { sessionId: created.sessionId, outcome: { status: 'failed' } }, bridgeAuth);
    const model = buildConsultationSummary(app.store.get(created.sessionId));
    assert.equal(model.caller.phone, null);
    assert.equal(model.request.practiceAreaId, null);
    assert.equal(model.outcome.appointmentStartsAt, null);
    const html = renderSummaryHtml(model);
    assert.ok(html.includes('Scheduling could not be completed'));
  });
});

// ---------------------------------------------------------------------------
// Mailer + delivery idempotency
// ---------------------------------------------------------------------------

test('booked outcome sends the summary exactly once; duplicates never resend', async () => {
  const mailer = fakeMailer();
  await withServer({ clock: fixedClock(AT_1515), mailer }, async (base) => {
    const created = await connectOne(base);
    const first = await (await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth)).json();
    assert.equal(first.summaryDelivery, 'sent');
    assert.equal(mailer.sends.length, 1);
    assert.equal(mailer.sends[0].subject, 'GuideHerd Consultation Summary — Ryan Scoggins — July 20, 2026');

    const dup = await (await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth)).json();
    assert.equal(dup.summaryDelivery, 'sent');
    assert.equal(mailer.sends.length, 1, 'no resend on duplicate outcome');
  });
});

test('concurrent duplicate outcomes cannot send duplicate email', async () => {
  const mailer = fakeMailer({ delayMs: 40 });
  await withServer({ clock: fixedClock(AT_1515), mailer }, async (base) => {
    const created = await connectOne(base);
    await Promise.all(
      Array.from({ length: 6 }, () => post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth)),
    );
    assert.equal(mailer.sends.length, 1, 'exactly one email despite concurrent duplicates');
  });
});

test('mail failure does not reverse the booking; retry after failure is allowed', async () => {
  const mailer = fakeMailer({ failFirst: true });
  await withServer({ clock: fixedClock(AT_1515), mailer }, async (base) => {
    const created = await connectOne(base);
    const first = await (await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth)).json();
    assert.equal(first.status, 'booked', 'booking stands despite mail failure');
    assert.equal(first.summaryDelivery, 'failed');

    const retry = await (await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth)).json();
    assert.equal(retry.summaryDelivery, 'sent', 'retry after failure succeeds');
    assert.equal(mailer.sends.length, 2);
  });
});

test('missing mail configuration yields a controlled not-configured result', async () => {
  const mailer = createMailer({ env: {} }); // no Microsoft credentials at all
  assert.equal(mailer.enabled, false);
  await withServer({ clock: fixedClock(AT_1515), mailer }, async (base) => {
    const created = await connectOne(base);
    const res = await (await post(base, '/api/v1/demo/outcome', bookedOutcome(created.sessionId), bridgeAuth)).json();
    assert.equal(res.status, 'booked');
    assert.equal(res.summaryDelivery, 'not-configured');
  });
});

test('Graph mailer: token + send mocked, 202 -> sent, non-202 -> failed, nothing sensitive logged', async () => {
  const logged = [];
  const original = console.log;
  console.log = (l) => logged.push(String(l));
  try {
    const calls = [];
    const okFetch = async (url, opts) => {
      calls.push({ url, opts });
      if (String(url).includes('login.microsoftonline.com')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'graph-token-abc' }) };
      }
      return { ok: true, status: 202, json: async () => ({}) };
    };
    const env = {
      MS_TENANT_ID: 't1', MS_CLIENT_ID: 'c1', MS_CLIENT_SECRET: 's3cr3t-value',
      SUMMARY_MAILBOX: 'sender@example.com', SUMMARY_RECIPIENT: 'firm@example.com',
    };
    const mailer = createMailer({ env, fetchImpl: okFetch });
    assert.equal(mailer.enabled, true);
    const result = await mailer.sendSummary({ subject: 'S', html: '<p>secret-body-content</p>' });
    assert.equal(result.status, 'sent');
    assert.equal(calls.length, 2, 'token request then send request');
    assert.ok(String(calls[1].url).includes('graph.microsoft.com'));
    assert.ok(String(calls[1].opts.headers.Authorization).startsWith('Bearer '));

    const badFetch = async (url) => String(url).includes('login.')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'x' }) }
      : { ok: false, status: 500, json: async () => ({}) };
    const failed = await createMailer({ env, fetchImpl: badFetch }).sendSummary({ subject: 'S', html: 'x' });
    assert.equal(failed.status, 'failed');

    const throwing = async () => { throw new Error('network down'); };
    const errored = await createMailer({ env, fetchImpl: throwing }).sendSummary({ subject: 'S', html: 'x' });
    assert.equal(errored.status, 'failed');

    const all = logged.join('\n');
    for (const leak of ['s3cr3t-value', 'graph-token-abc', 'secret-body-content', 'firm@example.com']) {
      assert.equal(all.includes(leak), false, `must not log: ${leak}`);
    }
  } finally {
    console.log = original;
  }
});

// ---------------------------------------------------------------------------
// Hygiene: bridge secret never logged
// ---------------------------------------------------------------------------

test('the bridge secret is never written to the request log', async () => {
  const logged = [];
  const original = console.log;
  console.log = (l) => logged.push(String(l));
  try {
    await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
      await createSession(base);
      await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
      assert.equal(logged.join('\n').includes(SECRET), false);
    });
  } finally {
    console.log = original;
  }
});

// ---------------------------------------------------------------------------
// Appointment validation: IANA timezone + complete ISO-8601 with offset
// ---------------------------------------------------------------------------

test('timezone must be a real IANA identifier; startsAt must carry an explicit offset or Z', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await connectOne(base);
    const attempt = (appointment) => post(base, '/api/v1/demo/outcome', {
      sessionId: created.sessionId,
      outcome: { status: 'booked', appointment },
    }, bridgeAuth);

    // Accepted
    const accepted = [
      { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' }, // offset
      { startsAt: '2026-07-20T20:00:00Z', timezone: 'UTC' },                  // Z
    ];
    // The first success terminates the session, so only probe the FIRST
    // accepted case live; validate the second shape on a fresh session below.
    assert.equal((await attempt(accepted[0])).status, 200, 'offset timestamp + IANA zone accepted');
  });

  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    const created = await connectOne(base);
    const res = await post(base, '/api/v1/demo/outcome', {
      sessionId: created.sessionId,
      outcome: { status: 'booked', appointment: { startsAt: '2026-07-20T20:00:00Z', timezone: 'UTC' } },
    }, bridgeAuth);
    assert.equal(res.status, 200, 'Z timestamp + UTC accepted');
  });
});

test('invalid timezones and ambiguous timestamps are rejected without side effects', async () => {
  const mailer = fakeMailer();
  await withServer({ clock: fixedClock(AT_1515), mailer }, async (base) => {
    const created = await connectOne(base);
    const rejected = [
      // timezone failures (startsAt valid)
      { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'Central Time' },
      { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'Mars/Olympus' },
      { startsAt: '2026-07-20T15:00:00-05:00', timezone: '' },
      // startsAt failures (timezone valid)
      { startsAt: '2026-07-20', timezone: 'America/Chicago' },                 // date-only
      { startsAt: '2026-07-20T15:00:00', timezone: 'America/Chicago' },        // no offset
      { startsAt: 'July 20 2026 3pm', timezone: 'America/Chicago' },           // not ISO
    ];
    for (const appointment of rejected) {
      const res = await post(base, '/api/v1/demo/outcome', {
        sessionId: created.sessionId,
        outcome: { status: 'booked', appointment },
      }, bridgeAuth);
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(appointment)}`);
    }

    // No mutation, no summary delivery from any invalid attempt.
    const status = await (await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { authorization: `Bearer ${created.consoleToken}` },
    })).json();
    assert.equal(status.status, 'connected', 'session not mutated by invalid outcomes');
    assert.equal(mailer.sends.length, 0, 'no summary delivery triggered');
  });
});

test('runtime caveat: ICU accepts legacy abbreviations like CST as identifiers (documented)', () => {
  // Node's Intl (ICU) treats "CST"/"EST" as valid identifiers even though they
  // are not canonical IANA Zone names. We accept what the runtime accepts and
  // use unambiguous non-identifiers for negative tests.
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: 'CST' }));
  assert.throws(() => new Intl.DateTimeFormat('en-US', { timeZone: 'Central Time' }), RangeError);
});

// ---------------------------------------------------------------------------
// Connect body tolerance (external assistant webhook UI requires a JSON body)
// ---------------------------------------------------------------------------

test('connect accepts no body, {}, {"request":"connect"}, and unknown fields identically', async () => {
  const variants = [
    { name: 'no body at all', init: { method: 'POST', headers: bridgeAuth } },
    { name: 'empty object {}', init: { method: 'POST', headers: { ...bridgeAuth, 'content-type': 'application/json' }, body: '{}' } },
    { name: '{"request":"connect"}', init: { method: 'POST', headers: { ...bridgeAuth, 'content-type': 'application/json' }, body: JSON.stringify({ request: 'connect' }) } },
    { name: 'unknown fields ignored', init: { method: 'POST', headers: { ...bridgeAuth, 'content-type': 'application/json' }, body: JSON.stringify({ request: 'connect', anything: 'else', nested: { x: 1 } }) } },
  ];

  const responses = [];
  for (const variant of variants) {
    await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
      const created = await createSession(base);
      const res = await fetch(`${base}/api/v1/demo/connect`, variant.init);
      assert.equal(res.status, 200, `${variant.name} -> 200`);
      const ctx = await res.json();
      assert.equal(ctx.sessionId, created.sessionId, `${variant.name} connects the prepared session`);
      // Normalize the per-run sessionId so shapes can be compared across variants.
      responses.push(JSON.stringify({ ...ctx, sessionId: 'X' }));
    });
  }
  // Every body variant produces the identical response shape and content.
  assert.equal(new Set(responses).size, 1, 'all variants behave identically');
});

test('connect body tolerance does not weaken authorization', async () => {
  await withServer({ clock: fixedClock(AT_1515) }, async (base) => {
    await createSession(base);
    const body = JSON.stringify({ request: 'connect' });
    const headers = { 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/v1/demo/connect`, { method: 'POST', headers, body })).status, 401, 'missing auth still 401');
    assert.equal((await fetch(`${base}/api/v1/demo/connect`, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })).status, 403, 'wrong secret still 403');
  });
});
