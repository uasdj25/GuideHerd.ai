'use strict';

/**
 * Operational telemetry tests (Issue #8): correlation IDs, the error
 * taxonomy, the event surface's redaction guarantees, bounded retry, the
 * mailer provider boundary, and the HTTP behavior end to end.
 *
 * All deterministic: fixed clocks, injected sleep (no real waiting),
 * injected fetch (no provider calls), captured logs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { createMailer } = require('../handoff/mailer');
const { extractCandidateCorrelationId, generateCorrelationId, CORRELATION_HEADER } = require('./correlation');
const { categorize, ERROR_CATEGORIES } = require('./taxonomy');
const { providerRateLimited, providerAuthenticationFailed } = require('./provider-errors');
const { createTelemetry, sanitizeError, EVENTS } = require('./telemetry');
const { withRetry } = require('./retry');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

// ── Correlation IDs ─────────────────────────────────────────────────────────

test('correlation: candidates are extracted only when well-formed; malformed or injection-shaped input yields none', () => {
  assert.match(generateCorrelationId(), /^gh-[0-9a-f]{24}$/);
  assert.notEqual(generateCorrelationId(), generateCorrelationId(), 'IDs are unique');

  assert.equal(extractCandidateCorrelationId('gh-abc123def456abc123def456'), 'gh-abc123def456abc123def456');
  assert.equal(extractCandidateCorrelationId('assistant-run-0042'), 'assistant-run-0042');

  // Absent, malformed, oversized, or injection-shaped input never yields a candidate.
  for (const bad of [undefined, 'short', 'has spaces here', 'x'.repeat(65), 'line\nbreak-injection', '"quoted"', '', '.leading-dot']) {
    assert.equal(extractCandidateCorrelationId(bad), null, `"${String(bad).slice(0, 12)}" must yield no candidate`);
  }
});

// ── Taxonomy ────────────────────────────────────────────────────────────────

test('taxonomy: domain errors, provider errors, and unknowns all categorize; never throws', () => {
  const { ValidationError, TooManyPreparedSessionsError, TokenExpiredError, NoPreparedSessionError } = require('../handoff/errors');
  const { PermissionDeniedError } = require('../identity/errors');
  const { ProviderUnavailableError } = require('../connect/errors');

  assert.equal(categorize(new ValidationError('x', [])).category, 'validation_error');
  assert.equal(categorize(new PermissionDeniedError()).category, 'forbidden');
  assert.equal(categorize(new NoPreparedSessionError()).category, 'not_found');
  assert.equal(categorize(new TokenExpiredError()).category, 'conflict', '410 gone is a state conflict');
  assert.equal(categorize(new TooManyPreparedSessionsError()).category, 'rate_limited');
  assert.equal(categorize(new ProviderUnavailableError()).category, 'provider_unavailable');
  assert.equal(categorize(providerRateLimited({ provider: 'p' })).category, 'provider_rate_limited');
  assert.equal(categorize(providerRateLimited({ provider: 'p' })).retryable, true);
  assert.equal(categorize(providerAuthenticationFailed({ provider: 'p' })).retryable, false);
  assert.equal(categorize(new Error('boom')).category, 'unexpected_error');
  assert.equal(categorize(null).category, 'unexpected_error');
  assert.equal(Object.keys(ERROR_CATEGORIES).length, 14);
});

// ── Event surface redaction ─────────────────────────────────────────────────

test('telemetry: unknown fields are dropped — a call site cannot leak PII or tokens through an event', () => {
  const lines = [];
  const tel = createTelemetry({ log: (l) => lines.push(l), clock: fixedClock(T0) });
  tel.event('request.failed', {
    severity: 'info',
    correlationId: 'gh-abc123def456abc123def456',
    component: 'http-api',
    category: 'not_found',
    // None of these are allowlisted — all must be dropped:
    callerName: 'Ryan Scoggins',
    email: 'ryan@example.com',
    phone: '+12565551212',
    bearerToken: 'gh_handoff_secret',
    authorization: 'Bearer xyz',
    body: { transcript: 'hello' },
  });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'guideherd.request.failed');
  assert.equal(entry.at, '2026-07-12T15:15:00.000Z');
  assert.equal(/Scoggins|example\.com|1212|gh_handoff_|Bearer|transcript/i.test(lines[0]), false, 'dropped, not logged');
});

test('telemetry: unknown event names are surfaced loudly; emitter never throws', () => {
  const lines = [];
  const tel = createTelemetry({ log: (l) => lines.push(l), clock: fixedClock(T0) });
  tel.event('made.up.event', { severity: 'info' });
  assert.ok(lines[0].includes('telemetry.unknown_event'));
  const throwing = createTelemetry({ log: () => { throw new Error('log broke'); }, clock: fixedClock(T0) });
  throwing.event('request.failed', {}); // must not throw
  assert.ok(EVENTS.includes('retry.attempted') && EVENTS.includes('retry.exhausted'));
});

test('telemetry: configuration.changed is cataloged and flows through (ADR-0015 §4, #65 review)', () => {
  const lines = [];
  const tel = createTelemetry({ log: (l) => lines.push(l), clock: fixedClock(T0) });
  tel.event('configuration.changed', {
    severity: 'info', component: 'configuration-store', operation: 'update',
    organizationKey: 'martinson-beason', subject: 'admin-ada', code: 'organization',
  });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'guideherd.configuration.changed');
  assert.equal(entry.subject, 'admin-ada');
  assert.equal(lines[0].includes('unknown_event'), false, 'no longer dropped');
});

test('telemetry: sanitizeError strips the message line and keeps only stack frames', () => {
  const err = new Error('SECRET-DATA caller@example.com +12565551212');
  const { errorName, stack } = sanitizeError(err);
  assert.equal(errorName, 'Error');
  assert.ok(stack && stack.includes('at '));
  assert.equal(/SECRET-DATA|example\.com|1212/.test(stack), false, 'no message content in sanitized stack');
});

// ── Retry policy ────────────────────────────────────────────────────────────

test('retry: retryable failures retry within bounds with backoff; success stops retrying', async () => {
  const sleeps = [];
  const events = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw providerRateLimited({ provider: 'p' });
    return 'ok';
  }, {
    attempts: 3,
    backoffMs: [100, 400],
    sleep: async (ms) => { sleeps.push(ms); },
    onEvent: (name, fields) => events.push({ name, ...fields }),
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 400], 'deterministic backoff, no real sleeping');
  assert.deepEqual(events.map((e) => [e.name, e.attempt]), [['retry.attempted', 1], ['retry.attempted', 2]]);
});

test('retry: non-retryable failures never retry; exhausted retries emit the final event', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw providerAuthenticationFailed({ provider: 'p' });
  }, { attempts: 3, sleep: async () => {} }), (e) => e.category === 'provider_authentication_failed');
  assert.equal(calls, 1, 'permanent failures are not retried');

  const events = [];
  calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw providerRateLimited({ provider: 'p' });
  }, {
    attempts: 3,
    sleep: async () => {},
    onEvent: (name, fields) => events.push({ name, ...fields }),
  }), (e) => e.category === 'provider_rate_limited');
  assert.equal(calls, 3, 'bounded attempts');
  assert.deepEqual(events.map((e) => e.name), ['retry.attempted', 'retry.attempted', 'retry.exhausted']);
  assert.equal(events[2].maxAttempts, 3);
});

// ── Mailer provider boundary ────────────────────────────────────────────────

const MAIL_ENV = {
  MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 'mail-secret-value',
  SUMMARY_MAILBOX: 'mb@example.com', SUMMARY_RECIPIENT: 'firm@example.com',
};

function fakeGraph(responses) {
  // responses: array of per-sendMail behaviors; token requests always succeed.
  const calls = { token: 0, send: 0 };
  const fetchImpl = async (url) => {
    if (String(url).includes('login.microsoftonline.com')) {
      calls.token += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), headers: { get: () => null } };
    }
    calls.send += 1;
    const behavior = responses[Math.min(calls.send - 1, responses.length - 1)];
    if (behavior instanceof Error) throw behavior;
    return { ok: behavior === 202, status: behavior, json: async () => ({}), headers: { get: (h) => (h === 'request-id' ? 'graph-req-1' : null) } };
  };
  return { fetchImpl, calls };
}

function capturedTelemetry() {
  const lines = [];
  return { lines, tel: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) }) };
}

test('mailer: 202 sends; provider 429 retries then succeeds; events are safe', async () => {
  const { fetchImpl, calls } = fakeGraph([429, 429, 202]);
  const { lines, tel } = capturedTelemetry();
  const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
  const result = await mailer.sendSummary({ subject: 's', html: '<p>x</p>' }, { correlationId: 'gh-abc123def456abc123def456', sessionId: 'sess-1', organizationKey: FIRM });
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(calls.send, 3);
  assert.deepEqual(lines.map((l) => l.event), ['guideherd.retry.attempted', 'guideherd.retry.attempted']);
  assert.equal(lines[0].provider, 'microsoft-graph');
  assert.equal(lines[0].correlationId, 'gh-abc123def456abc123def456');
  const flat = JSON.stringify(lines);
  assert.equal(/mail-secret-value|tok|firm@example\.com|<p>/.test(flat), false, 'no credentials, tokens, recipients, or content in events');
});

test('mailer: exhausted retries fail with final events; provider request id recorded as secondary reference', async () => {
  const { fetchImpl, calls } = fakeGraph([429, 429, 429]);
  const { lines, tel } = capturedTelemetry();
  const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
  const result = await mailer.sendSummary({ subject: 's', html: 'x' }, { correlationId: 'gh-abc123def456abc123def456' });
  assert.deepEqual(result, { status: 'failed' }, 'boundary contract preserved');
  assert.equal(calls.send, 3, 'bounded');
  const names = lines.map((l) => l.event);
  assert.deepEqual(names, [
    'guideherd.retry.attempted', 'guideherd.retry.attempted', 'guideherd.retry.exhausted',
    'guideherd.provider.rate_limited', 'guideherd.summary.delivery_failed',
  ]);
  const providerEvent = lines[3];
  assert.equal(providerEvent.providerRequestId, 'graph-req-1', 'provider id is a safe secondary reference');
  assert.equal(providerEvent.httpStatus, 429);
});

test('mailer: authentication failures and rejected requests never retry', async () => {
  for (const [status, category] of [[401, 'provider.authentication_failed'], [400, 'provider.rejected_request']]) {
    const { fetchImpl, calls } = fakeGraph([status]);
    const { lines, tel } = capturedTelemetry();
    const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
    const result = await mailer.sendSummary({ subject: 's', html: 'x' }, {});
    assert.deepEqual(result, { status: 'failed' });
    assert.equal(calls.send, 1, `${status} is not retried`);
    assert.equal(lines[0].event, `guideherd.${category}`);
  }
});

test('mailer: timeouts and mid-flight resets are ambiguous — classified, logged, never retried (no duplicate email risk)', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const { fetchImpl, calls } = fakeGraph([abort]);
  const { lines, tel } = capturedTelemetry();
  const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
  const result = await mailer.sendSummary({ subject: 's', html: 'x' }, {});
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(calls.send, 1, 'an ambiguous failure is never retried');
  assert.equal(lines[0].event, 'guideherd.provider.timeout');
});

test('mailer: connection-phase failures (request never left) are retried', async () => {
  const refused = new Error('connect ECONNREFUSED');
  refused.code = 'ECONNREFUSED';
  const { fetchImpl, calls } = fakeGraph([refused, 202]);
  const { tel } = capturedTelemetry();
  const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {} });
  const result = await mailer.sendSummary({ subject: 's', html: 'x' }, {});
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(calls.send, 2);
});

// ── HTTP behavior end to end ────────────────────────────────────────────────

async function withServer(opts, fn) {
  const lines = [];
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    telemetry: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) }),
    ...opts,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app, lines);
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

const bridgeAuth = { authorization: `Bearer ${SECRET}` };

function createBody() {
  return {
    firmId: FIRM,
    caller: { fullName: 'Test Caller', email: 'caller@example.com', phone: '+12565550100' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

test('HTTP: every response carries the correlation header — success, failure, and preflight', async () => {
  await withServer({}, async (base) => {
    // Failure first: no session is prepared yet, so connect 404s.
    const failure = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(failure.status, 404);

    const success = await post(base, '/api/v1/handoffs', createBody());
    assert.equal(success.status, 201);
    assert.match(success.headers.get(CORRELATION_HEADER), /^gh-[0-9a-f]{24}$/);
    const headerId = failure.headers.get(CORRELATION_HEADER);
    assert.match(headerId, /^gh-[0-9a-f]{24}$/);
    const body = await failure.json();
    assert.equal(body.error.correlationId, headerId, 'envelope and header agree');

    const preflight = await fetch(base + '/api/v1/handoffs', {
      method: 'OPTIONS', headers: { origin: 'https://guideherd.ai' },
    });
    assert.ok(preflight.headers.get(CORRELATION_HEADER));
  });
});

test('HTTP: an authenticated trusted service identity can propagate a supplied correlation ID', async () => {
  await withServer({}, async (base, app, lines) => {
    const supplied = 'assistant-run-0042';
    const res = await post(base, '/api/v1/demo/connect', {}, { ...bridgeAuth, [CORRELATION_HEADER]: supplied });
    assert.equal(res.headers.get(CORRELATION_HEADER), supplied, 'service-authenticated inbound ID propagates');
    assert.equal((await res.json()).error.correlationId, supplied);
    assert.ok(lines.some((l) => l.correlationId === supplied), 'the inherited ID reaches structured events');

    // Shape validation holds even for the trusted service: malformed input is replaced.
    const malformed = await post(base, '/api/v1/demo/connect', {}, { ...bridgeAuth, [CORRELATION_HEADER]: 'bad id with spaces "and quotes"' });
    assert.match(malformed.headers.get(CORRELATION_HEADER), /^gh-[0-9a-f]{24}$/, 'malformed input replaced even when authenticated');
  });
});

test('HTTP: anonymous and capability-token callers can never inject a correlation ID', async () => {
  await withServer({}, async (base, app, lines) => {
    const supplied = 'attacker-chosen-id-123';

    // Anonymous create (browser surface): the supplied ID is ignored.
    const anon = await post(base, '/api/v1/handoffs', createBody(), { [CORRELATION_HEADER]: supplied });
    assert.equal(anon.status, 201);
    assert.match(anon.headers.get(CORRELATION_HEADER), /^gh-[0-9a-f]{24}$/);
    assert.notEqual(anon.headers.get(CORRELATION_HEADER), supplied);
    const created = await anon.json();

    // Capability-token request (console token): still ignored.
    const cap = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, {
      headers: { authorization: `Bearer ${created.consoleToken}`, [CORRELATION_HEADER]: supplied },
    });
    assert.equal(cap.status, 200);
    assert.match(cap.headers.get(CORRELATION_HEADER), /^gh-[0-9a-f]{24}$/);
    assert.notEqual(cap.headers.get(CORRELATION_HEADER), supplied);

    // An UNAUTHENTICATED demo-path request (wrong secret): ignored — the
    // candidate is adopted only after successful service authentication.
    const badAuth = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer wrong', [CORRELATION_HEADER]: supplied });
    assert.equal(badAuth.status, 403);
    assert.notEqual(badAuth.headers.get(CORRELATION_HEADER), supplied);

    // The attacker-chosen value never reaches any log or event.
    assert.equal(JSON.stringify(lines).includes(supplied), false, 'injected value absent from telemetry');
  });
});

test('HTTP: a non-service (user-type) identity cannot propagate a correlation ID', async () => {
  const staticIdentitiesJson = JSON.stringify([
    { token: 'tok-user', subject: 'a-user', type: 'user', roles: ['scheduling-assistant'], organizationKey: FIRM },
  ]);
  await withServer({ staticIdentitiesJson }, async (base) => {
    const supplied = 'user-chosen-id-99';
    const res = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer tok-user', [CORRELATION_HEADER]: supplied });
    // Authenticated and authorized (role held), but not a service identity:
    // the supplied ID is not adopted.
    assert.notEqual(res.headers.get(CORRELATION_HEADER), supplied);
    assert.match(res.headers.get(CORRELATION_HEADER), /^gh-[0-9a-f]{24}$/);
  });
});

test('HTTP: validation failures emit a safe structured event with the correlation ID', async () => {
  await withServer({}, async (base, app, lines) => {
    const res = await post(base, '/api/v1/handoffs', { firmId: FIRM, caller: { fullName: 'PII Name', email: 'pii@example.com' } });
    assert.equal(res.status, 400);
    const event = lines.find((l) => l.event === 'guideherd.validation.failed');
    assert.ok(event, 'validation failure evented');
    assert.equal(event.category, 'validation_error');
    assert.equal(event.httpStatus, 400);
    assert.match(event.correlationId, /^gh-/);
    assert.equal(/PII Name|pii@example\.com/.test(JSON.stringify(lines)), false, 'no caller data in events');
  });
});

test('HTTP: unexpected internal errors map to a calm 500 with correlation ID and sanitized internal diagnostics', async () => {
  await withServer({}, async (base, app, lines) => {
    // Force an unexpected failure beneath a route: break the store.
    app.store.connectEligible = async () => { throw new Error('pg exploded: SELECT * FROM handoff_sessions WHERE caller_email = x'); };
    const res = await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'internal_error');
    assert.equal(body.error.message, 'An unexpected error occurred.');
    assert.match(body.error.correlationId, /^gh-/);
    assert.ok(body.error.callerMessage.includes('Something went wrong'), 'calm caller message on the Connect surface');
    assert.equal(/pg exploded|SELECT|caller_email/.test(JSON.stringify(body)), false, 'no exception text to callers');

    const event = lines.find((l) => l.event === 'guideherd.internal.unexpected_error');
    assert.ok(event);
    assert.equal(event.errorName, 'Error');
    assert.ok(event.stack && event.stack.includes('at '), 'sanitized stack for diagnosis');
    assert.equal(/pg exploded|SELECT|caller_email/.test(event.stack || ''), false, 'message stripped from stack');
  });
});

test('HTTP: Connect-facing failures carry calm caller messages with no provider or implementation details', async () => {
  await withServer({}, async (base) => {
    // 404 no prepared session
    const notFound = await (await post(base, '/api/v1/demo/connect', {}, bridgeAuth)).json();
    assert.ok(notFound.error.callerMessage.length > 0);
    // 409 ambiguity
    await post(base, '/api/v1/handoffs', createBody());
    await post(base, '/api/v1/handoffs', createBody());
    const ambiguous = await (await post(base, '/api/v1/demo/connect', {}, bridgeAuth)).json();
    assert.equal(ambiguous.error.code, 'ambiguous_prepared_sessions');
    assert.ok(ambiguous.error.callerMessage.length > 0);

    for (const envelope of [notFound, ambiguous]) {
      const text = JSON.stringify(envelope);
      assert.equal(/elevenlabs|twilio|graph|cal\.com|postgres|http|500|stack|exception/i.test(envelope.error.callerMessage), false, 'no provider or implementation details');
      assert.equal(/gh_handoff_|gh_console_|Bearer/.test(text), false);
    }

    // Browser-facing (non-demo) routes do NOT carry callerMessage.
    const browserErr = await (await post(base, '/api/v1/handoffs', { bad: true })).json();
    assert.equal(browserErr.error.callerMessage, undefined);
  });
});

test('HTTP: retried outcome reports stay idempotent — one booking, one summary, no duplicates', async () => {
  const sends = [];
  await withServer({
    mailer: { enabled: true, async sendSummary(m) { sends.push(m); return { status: 'sent' }; } },
  }, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
    await post(base, '/api/v1/demo/connect', {}, bridgeAuth);
    const outcome = {
      sessionId: created.sessionId,
      status: 'booked',
      appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
      reason: 'Booked.',
    };
    // A client-side retry storm: five identical reports, some concurrent.
    const [a, b] = await Promise.all([
      post(base, '/api/v1/demo/outcome', outcome, bridgeAuth),
      post(base, '/api/v1/demo/outcome', outcome, bridgeAuth),
    ]);
    const c = await post(base, '/api/v1/demo/outcome', outcome, bridgeAuth);
    for (const r of [a, b, c]) assert.equal(r.status, 200, 'idempotent duplicates all answer 200');
    assert.equal(sends.length, 1, 'exactly one Consultation Summary despite retries');

    // A conflicting retry can never overwrite the booking.
    const conflict = await post(base, '/api/v1/demo/outcome', { sessionId: created.sessionId, status: 'failed', reason: 'nope' }, bridgeAuth);
    assert.equal(conflict.status, 409);
  });
});

test('HTTP: request logs carry the correlation ID and never tokens or caller PII', async () => {
  const logged = [];
  const original = console.log;
  console.log = (l) => logged.push(String(l));
  try {
    await withServer({}, async (base) => {
      const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
      await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, { headers: { authorization: `Bearer ${created.consoleToken}` } });
      const requestLogs = logged.filter((l) => l.includes('"path"'));
      assert.ok(requestLogs.every((l) => JSON.parse(l).correlationId), 'every request log line carries a correlation ID');
      const flat = logged.join('\n');
      assert.equal(/gh_handoff_|gh_console_|Test Caller|caller@example\.com|2565550100/.test(flat), false);
    });
  } finally {
    console.log = original;
  }
});

// ── Bounded provider requests (#60) ────────────────────────────────────────

/** A fetch that never resolves but honors the request's AbortSignal. */
const hangingFetch = (url, opts) => new Promise((resolve, reject) => {
  opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
});

test('mailer #60: a hung TOKEN request aborts within the bound and is retried (no mail was sent)', async () => {
  const lines = [];
  const tel = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    if (calls === 1) return hangingFetch(url, opts); // token hang
    if (String(url).includes('login.microsoftonline.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), headers: new Headers() };
    }
    return { ok: true, status: 202, json: async () => ({}), headers: new Headers() };
  };
  const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {}, requestTimeoutMs: 20 });
  const result = await mailer.sendSummary({ subject: 's', html: '<p>h</p>' });
  assert.deepEqual(result, { status: 'sent' }, 'token-phase timeout retried safely to success');
  assert.ok(lines.some((l) => l.event === 'guideherd.retry.attempted'));
});

test('mailer #60: a hung SEND request aborts within the bound and is NOT retried (acceptance ambiguous)', async () => {
  const lines = [];
  const tel = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
  let sendCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('login.microsoftonline.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), headers: new Headers() };
    }
    sendCalls += 1;
    return hangingFetch(url, opts);
  };
  const started = Date.now();
  const mailer = createMailer({ env: MAIL_ENV, fetchImpl, telemetry: tel, sleep: async () => {}, requestTimeoutMs: 20 });
  const result = await mailer.sendSummary({ subject: 's', html: '<p>h</p>' });
  assert.ok(Date.now() - started < 2000, 'bounded, not hanging');
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(sendCalls, 1, 'ambiguous acceptance: never retried');
  assert.ok(lines.some((l) => l.event === 'guideherd.provider.timeout'));
  assert.ok(lines.some((l) => l.event === 'guideherd.summary.delivery_failed'));
});
