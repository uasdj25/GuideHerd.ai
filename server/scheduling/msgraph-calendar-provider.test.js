'use strict';

/**
 * Microsoft Graph calendar provider (GitLab #84/#85/#86): certified by
 * the SAME conformance suite as the reference provider, over a mocked
 * Graph tenant that answers the documented endpoints — plus
 * Graph-specific contract tests (request shapes, transactionId,
 * getSchedule classification, discovery, binding verification). Live
 * behavior remains #95's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { runCalendarProviderContractSuite } = require('./calendar-provider-contract-suite');
const {
  createGraphCalendarProvider, CORRELATION_PROPERTY_ID, clampGraphTimeoutMs,
} = require('./msgraph-calendar-provider');
const { CalendarUnavailableError } = require('./calendar-provider');

const fakeAuth = () => ({ configured: true, async getToken() { return 'tok-test'; }, invalidate() {} });

/**
 * A mocked Microsoft 365 tenant: in-memory mailboxes + events behind the
 * documented Graph endpoint shapes, exposing the conformance-harness
 * surface (givenCalendar / injectFailure / attempts / eventsOn).
 */
function createMockGraphTenant() {
  const mailboxes = new Map(); // ref -> { displayName, writable, busy, events: Map }
  const injected = new Map(); // contract operation -> kind (one-shot)
  const attemptCounts = new Map();
  const requests = [];

  const bump = (op) => attemptCounts.set(op, (attemptCounts.get(op) || 0) + 1);
  const parseUtc = (dt) => Date.parse(String(dt).endsWith('Z') ? dt : `${dt}Z`);
  const take = (op) => {
    const kind = injected.get(op);
    if (kind) injected.delete(op);
    return kind || null;
  };
  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === '__unparseable__') throw new SyntaxError('bad json');
      return body;
    },
  });
  const applyInjection = (kind, { onAmbiguousCreated } = {}) => {
    if (kind === 'timeout') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    if (kind === 'network') throw Object.assign(new Error('n'), { code: 'ECONNRESET' });
    if (kind === 'http_500') return respond(500, {});
    if (kind === 'reject') return respond(400, { error: { code: 'ErrorInvalidRequest' } });
    if (kind === 'unparseable') return respond(200, '__unparseable__');
    if (kind === 'ambiguous_created') {
      onAmbiguousCreated();
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    }
    return null;
  };
  const eventInterval = (e) => ({
    startMs: Date.parse(e.startsAt),
    endMs: Date.parse(e.startsAt) + e.durationMinutes * 60_000,
  });
  const graphEvent = (e) => ({
    id: e.providerEventId,
    subject: e.summary,
    start: { dateTime: e.startsAt.replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: new Date(eventInterval(e).endMs).toISOString().replace('Z', ''), timeZone: 'UTC' },
    isCancelled: e.status === 'cancelled',
    singleValueExtendedProperties: [{ id: CORRELATION_PROPERTY_ID, value: e.correlationId }],
  });

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    requests.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });

    // GET /v1.0/users (discovery)
    if (method === 'GET' && path === '/v1.0/users') {
      bump('discoverCalendars');
      const kind = take('discoverCalendars');
      if (kind) { const r = applyInjection(kind); if (r) return r; }
      return respond(200, {
        value: [...mailboxes.entries()].map(([ref, m]) => ({
          id: `id-${ref}`, displayName: m.displayName, mail: ref, userPrincipalName: ref,
        })),
      });
    }

    const userMatch = path.match(/^\/v1\.0\/users\/([^/]+)(.*)$/);
    if (!userMatch) return respond(404, { error: { code: 'ResourceNotFound' } });
    const [, ref, rest] = userMatch;
    const mailbox = mailboxes.get(ref);

    // POST getSchedule (free/busy)
    if (method === 'POST' && rest === '/calendar/getSchedule') {
      bump('fetchBusyIntervals');
      const kind = take('fetchBusyIntervals');
      if (kind) { const r = applyInjection(kind); if (r) return r; }
      if (!mailbox) return respond(404, { error: { code: 'ErrorInvalidUser' } });
      const body = JSON.parse(init.body);
      const winStart = parseUtc(body.startTime.dateTime);
      const winEnd = parseUtc(body.endTime.dateTime);
      const items = [];
      for (const b of mailbox.busy) {
        if (Date.parse(b.startsAt) < winEnd && Date.parse(b.endsAt) > winStart) {
          items.push({
            status: b.status || 'busy',
            start: { dateTime: b.startsAt.replace('Z', ''), timeZone: 'UTC' },
            end: { dateTime: b.endsAt.replace('Z', ''), timeZone: 'UTC' },
          });
        }
      }
      for (const e of mailbox.events.values()) {
        if (e.status === 'cancelled') continue;
        const { startMs, endMs } = eventInterval(e);
        if (startMs < winEnd && endMs > winStart) {
          items.push({
            status: 'busy',
            start: { dateTime: e.startsAt.replace('Z', ''), timeZone: 'UTC' },
            end: { dateTime: new Date(endMs).toISOString().replace('Z', ''), timeZone: 'UTC' },
          });
        }
      }
      return respond(200, { value: [{ scheduleId: ref, scheduleItems: items }] });
    }

    // GET /calendar (binding verification)
    if (method === 'GET' && rest.startsWith('/calendar')) {
      if (!mailbox) return respond(404, { error: { code: 'ErrorInvalidUser' } });
      if (!mailbox.writable) return respond(403, { error: { code: 'ErrorAccessDenied' } });
      return respond(200, { id: `cal-${ref}`, name: 'Calendar' });
    }

    // Events collection
    if (rest === '/events' && method === 'POST') {
      bump('createEvent');
      const kind = take('createEvent');
      if (!mailbox) return respond(404, { error: { code: 'ErrorInvalidUser' } });
      if (!mailbox.writable) return respond(403, { error: { code: 'ErrorAccessDenied' } });
      const body = JSON.parse(init.body);
      const props = body.singleValueExtendedProperties || [];
      const corr = (props.find((p) => p.id === CORRELATION_PROPERTY_ID) || {}).value || null;
      const store = () => {
        const e = {
          providerEventId: `graph-evt-${crypto.randomUUID()}`,
          startsAt: new Date(parseUtc(body.start.dateTime)).toISOString(),
          durationMinutes: Math.round((parseUtc(body.end.dateTime) - parseUtc(body.start.dateTime)) / 60_000),
          summary: body.subject,
          correlationId: corr,
          transactionId: body.transactionId || null,
          status: 'confirmed',
        };
        mailbox.events.set(e.providerEventId, e);
        return e;
      };
      if (kind) {
        const r = applyInjection(kind, { onAmbiguousCreated: store });
        if (r) return r;
      }
      const e = store();
      return respond(201, graphEvent(e));
    }
    if (rest === '/events' && method === 'GET') {
      bump('findEventByCorrelation');
      const kind = take('findEventByCorrelation');
      if (kind) { const r = applyInjection(kind); if (r) return r; }
      if (!mailbox) return respond(404, { error: { code: 'ErrorInvalidUser' } });
      const filter = u.searchParams.get('$filter') || '';
      const m = filter.match(/ep\/value eq '([^']*)'/);
      const wanted = m ? m[1].replace(/''/g, "'") : null;
      const matches = [...mailbox.events.values()].filter((e) => e.correlationId === wanted);
      return respond(200, { value: matches.map(graphEvent) });
    }

    // Single event
    const eventMatch = rest.match(/^\/events\/([^/?]+)/);
    if (eventMatch) {
      if (!mailbox) return respond(404, { error: { code: 'ErrorInvalidUser' } });
      const event = mailbox.events.get(eventMatch[1]);
      if (method === 'GET') {
        if (!event) return respond(404, { error: { code: 'ErrorItemNotFound' } });
        return respond(200, graphEvent(event));
      }
      if (method === 'PATCH') {
        bump('updateEvent');
        const kind = take('updateEvent');
        if (kind) { const r = applyInjection(kind); if (r) return r; }
        if (!mailbox.writable) return respond(403, { error: { code: 'ErrorAccessDenied' } });
        if (!event) return respond(404, { error: { code: 'ErrorItemNotFound' } });
        const body = JSON.parse(init.body);
        if (body.start) {
          const startMs = parseUtc(body.start.dateTime);
          const endMs = parseUtc(body.end.dateTime);
          event.startsAt = new Date(startMs).toISOString();
          event.durationMinutes = Math.round((endMs - startMs) / 60_000);
        }
        return respond(200, graphEvent(event));
      }
      if (method === 'DELETE') {
        bump('cancelEvent');
        const kind = take('cancelEvent');
        if (kind) { const r = applyInjection(kind); if (r) return r; }
        if (!mailbox.writable) return respond(403, { error: { code: 'ErrorAccessDenied' } });
        if (!event) return respond(404, { error: { code: 'ErrorItemNotFound' } });
        event.status = 'cancelled';
        return respond(204, null);
      }
    }
    return respond(404, { error: { code: 'ResourceNotFound' } });
  };

  return {
    fetchImpl,
    requests,
    givenCalendar(ref, { displayName = ref, writable = true, busy = [] } = {}) {
      mailboxes.set(ref, {
        displayName,
        writable,
        busy: busy.map((b) => ({
          startsAt: new Date(b.startsAt).toISOString(),
          endsAt: new Date(b.endsAt).toISOString(),
          status: b.status,
        })),
        events: new Map(),
      });
    },
    injectFailure(op, kind) { injected.set(op, kind); },
    attempts(op) { return attemptCounts.get(op) || 0; },
    eventsOn(ref) {
      const m = mailboxes.get(ref);
      return m ? [...m.events.values()].map((e) => ({ ...e })) : [];
    },
  };
}

function makeHarness() {
  const tenant = createMockGraphTenant();
  const provider = createGraphCalendarProvider({ auth: fakeAuth(), fetchImpl: tenant.fetchImpl });
  return {
    provider,
    givenCalendar: tenant.givenCalendar,
    injectFailure: tenant.injectFailure,
    attempts: tenant.attempts,
    eventsOn: tenant.eventsOn,
    tenant,
  };
}

// The certification bar: the SAME suite the reference provider passes.
runCalendarProviderContractSuite('msgraph provider (mocked tenant)', makeHarness);

// ── Graph-specific contract tests ───────────────────────────────────────────

test('graph: createEvent sends UTC times, the correlation extended property, AND transactionId', async () => {
  const h = makeHarness();
  h.givenCalendar('clay@firm.example', {});
  await h.provider.createEvent({
    calendarRef: 'clay@firm.example',
    startsAt: '2026-09-01T14:00:00.000Z',
    durationMinutes: 30,
    summary: 'Firm — Consultation with Pat Caller',
    attendee: { name: 'Pat Caller', email: 'pat@example.com' },
    correlationId: 'bc_corr-1',
  });
  const req = h.tenant.requests.find((r) => r.method === 'POST' && r.url.includes('/events'));
  assert.equal(req.body.start.timeZone, 'UTC');
  assert.equal(req.body.transactionId, 'bc_corr-1',
    'documented idempotency token set (retry stays OFF until #95 proves it)');
  assert.deepEqual(req.body.singleValueExtendedProperties,
    [{ id: CORRELATION_PROPERTY_ID, value: 'bc_corr-1' }]);
  assert.equal(req.body.attendees[0].emailAddress.address, 'pat@example.com');
});

test('graph: getSchedule classification — busy/oof/tentative block; free/workingElsewhere do not', async () => {
  const h = makeHarness();
  h.givenCalendar('clay@firm.example', {
    busy: [
      { startsAt: '2026-09-01T14:00:00Z', endsAt: '2026-09-01T14:30:00Z', status: 'busy' },
      { startsAt: '2026-09-01T15:00:00Z', endsAt: '2026-09-01T15:30:00Z', status: 'tentative' },
      { startsAt: '2026-09-01T16:00:00Z', endsAt: '2026-09-01T16:30:00Z', status: 'oof' },
      { startsAt: '2026-09-01T17:00:00Z', endsAt: '2026-09-01T17:30:00Z', status: 'free' },
      { startsAt: '2026-09-01T18:00:00Z', endsAt: '2026-09-01T18:30:00Z', status: 'workingElsewhere' },
    ],
  });
  const { intervals } = await h.provider.fetchBusyIntervals({
    calendarRef: 'clay@firm.example',
    startUtcMs: Date.parse('2026-09-01T00:00:00Z'),
    endUtcMs: Date.parse('2026-09-02T00:00:00Z'),
  });
  assert.deepEqual(intervals.map((i) => i.startsAt), [
    '2026-09-01T14:00:00.000Z', '2026-09-01T15:00:00.000Z', '2026-09-01T16:00:00.000Z',
  ]);
});

test('graph: a received 429 on a write is a DEFINITIVE throttle rejection, never ambiguity', async () => {
  const h = makeHarness();
  h.givenCalendar('clay@firm.example', {});
  // Simulate 429 via a scripted transport for one call.
  const provider = createGraphCalendarProvider({
    auth: fakeAuth(),
    fetchImpl: async () => ({ ok: false, status: 429, async json() { return {}; } }),
  });
  await assert.rejects(
    provider.createEvent({
      calendarRef: 'clay@firm.example', startsAt: '2026-09-01T14:00:00.000Z',
      durationMinutes: 30, summary: 'x', correlationId: 'bc_x',
    }),
    (err) => err.code === 'calendar_write_rejected' && err.detail === 'provider_throttled',
  );
});

test('graph: discovery lists mailboxes; binding verification distinguishes accessible from not', async () => {
  const h = makeHarness();
  h.givenCalendar('clay@firm.example', { displayName: 'Clay Martinson' });
  h.givenCalendar('locked@firm.example', { writable: false });
  const found = await h.provider.discoverCalendars();
  assert.deepEqual(found.find((c) => c.calendarRef === 'clay@firm.example'), {
    calendarRef: 'clay@firm.example', displayName: 'Clay Martinson',
    capabilities: { read: true, write: true },
  });
  assert.deepEqual(await h.provider.verifyCalendarBinding({ calendarRef: 'clay@firm.example' }),
    { calendarRef: 'clay@firm.example', accessible: true, verifiedVia: 'calendar-read' });
  assert.equal((await h.provider.verifyCalendarBinding({ calendarRef: 'locked@firm.example' })).accessible, false);
  assert.equal((await h.provider.verifyCalendarBinding({ calendarRef: 'ghost@firm.example' })).accessible, false);
});

test('graph: transient trouble during binding verification is NOT "inaccessible" — it fails closed', async () => {
  const provider = createGraphCalendarProvider({
    auth: fakeAuth(),
    fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
  });
  await assert.rejects(
    provider.verifyCalendarBinding({ calendarRef: 'clay@firm.example' }),
    (err) => err instanceof CalendarUnavailableError && err.detail === 'provider_timeout',
  );
});

test('graph: timeout budget is clamped', () => {
  assert.equal(clampGraphTimeoutMs(undefined), 4000);
  assert.equal(clampGraphTimeoutMs(50), 250);
  assert.equal(clampGraphTimeoutMs(60_000), 10_000);
});
