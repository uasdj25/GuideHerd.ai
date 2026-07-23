'use strict';

/**
 * Governed booking tests: the booking half of the consolidated
 * scheduling flow. Covers request validation (no event-type-, route-, or
 * duration-shaped input exists to override), tenant authorization,
 * availability↔booking event-type parity across all three routes with
 * the production mappings, single-use booking contexts (concurrency,
 * reuse, expiry, cross-tenant opacity), the fail-closed provider-outcome
 * matrix (definitive rejection vs. ambiguous verification_required, zero
 * retries), confirmed-but-unpersisted demotion, walk-in callers, the
 * Cal.com booking client contract, startup reconciliation, and secret
 * hygiene (the raw bookingContext value never reaches telemetry).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { createTelemetry } = require('../telemetry/telemetry');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createInMemoryBookingContextStore, BookingContextStatus } = require('./booking-context-store');
const { BOOKING_CONTEXT_TTL_MS } = require('./offered-slots');
const {
  createCalcomBookingProvider,
  reconcileStaleBookingContexts,
  clampBookingTimeoutMs,
  BookingRejectedByProviderError,
  BookingUnverifiedError,
  BOOKING_CAL_API_VERSION,
  MAX_BOOKING_TIMEOUT_MS,
} = require('./booking');

const FIRM = 'martinson-beason';
const SECRET = 'demo-secret-for-tests-only';
const T0 = Date.parse('2026-08-30T15:15:00Z');
const CHI = 'America/Chicago';
const HOURS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opens: '09:00', closes: '17:00' }));
const SEP_TUE_9AM = '2026-09-01T14:00:00.000Z';
const SEP_TUE_930AM = '2026-09-01T14:30:00.000Z';
const WEEK = { dateFrom: '2026-09-01', dateTo: '2026-09-07' };

/** The three live production mappings (read back at Gate 10). */
const PRODUCTION_CALCOM = {
  eventTypeId: 6287134,
  attorneyEventTypes: { 'clay-martinson': 6287134, 'doug-martinson': 6330128 },
  routingGroupEventTypes: { probate: 6330099 },
  durationMinutes: 30,
};

function fixtureConfig({ calcom } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: CHI });
  configService.locations.create(FIRM, { key: 'huntsville', name: 'Huntsville Office', timezone: CHI, officeHours: HOURS });
  for (const key of ['clay-martinson', 'doug-martinson', 'raina-baugher']) {
    configService.providers.create(FIRM, { key, name: key, active: true });
  }
  configService.serviceAreas.create(FIRM, { key: 'probate', name: 'Probate', active: true });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', active: true });
  configService.routingGroups.create(FIRM, {
    key: 'probate', name: 'Probate', serviceArea: 'probate', active: true,
    providers: ['clay-martinson', 'doug-martinson'],
  });
  configService.settings.set(FIRM, 'scheduling', 'calcom-availability', calcom || PRODUCTION_CALCOM);
  return configService;
}

function mockAvailability(slots = [{ startsAt: SEP_TUE_9AM }, { startsAt: SEP_TUE_930AM }]) {
  const calls = [];
  return { calls, key: 'mock', timeoutMs: 1200, async fetchAvailability(args) { calls.push(args); return { slots }; } };
}

/** A scripted booking provider; records every createBooking it serves. */
function mockBooking(behavior) {
  const calls = [];
  return {
    calls,
    key: 'mock',
    timeoutMs: 2500,
    configured: true,
    async createBooking(args) {
      calls.push(args);
      const result = typeof behavior === 'function' ? behavior(args) : behavior;
      if (result instanceof Error) throw result;
      return result || { uid: 'uid_ok', sanitized: { uid: 'uid_ok', start: args.startsAt } };
    },
  };
}

function captureTelemetry(clock) {
  const lines = [];
  return { lines, telemetry: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock }) };
}

async function withServer(opts, fn) {
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: false, async sendSummary() { return { status: 'not-configured' }; } },
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

const auth = { authorization: `Bearer ${SECRET}` };
const post = (base, path_, body, headers = {}) => fetch(base + path_, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const offered = (base, body, headers = auth) => post(base, '/api/v1/scheduling/offered-slots', body, headers);
const book = (base, body, headers = auth) => post(base, '/api/v1/scheduling/book', body, headers);
const ATTENDEE = { name: 'Pat Caller', email: 'pat@example.com', phoneNumber: '+12565550100' };

/** Obtain a live bookingContext by running a governed availability check. */
async function obtainContext(base, request = {}) {
  const res = await (await offered(base, { ...WEEK, ...request })).json();
  assert.equal(res.status, 'offered');
  assert.ok(res.bookingContext, 'an offered response carries the booking context');
  return res;
}

// ── Validation and authorization ────────────────────────────────────────────

test('book: request validation — the model has NO event-type-, route-, or duration-shaped input; auth is tenant-scoped', async () => {
  const booking = mockBooking();
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking }, async (base) => {
    const valid = { bookingContext: 'bct_x', startsAt: SEP_TUE_9AM, attendee: ATTENDEE };
    assert.equal((await book(base, {})).status, 400);
    assert.equal((await book(base, { ...valid, startsAt: 'tomorrow at nine' })).status, 400);
    assert.equal((await book(base, { ...valid, attendee: { name: 'Pat' } })).status, 400, 'email required');
    assert.equal((await book(base, { ...valid, attendee: { ...ATTENDEE, email: 'not-an-email' } })).status, 400);
    // The LLM cannot supply or override routing: every such field is unknown.
    for (const field of ['eventTypeId', 'routeKind', 'attorneyId', 'routingGroupKey', 'durationMinutes', 'slots']) {
      assert.equal((await book(base, { ...valid, [field]: 6330128 })).status, 400, `${field} is not accepted`);
    }
    assert.equal((await book(base, { ...valid, attendee: { ...ATTENDEE, timeZone: 'America/New_York' } })).status, 400,
      'attendee timezone comes from tenant configuration, never the model');
    assert.equal((await book(base, valid, {})).status, 401);
    assert.equal((await book(base, valid, { authorization: 'Bearer wrong' })).status, 403);
    assert.equal(booking.calls.length, 0, 'no provider call for an invalid request');
  });
});

test('book: an authenticated identity WITHOUT an organization is refused — no demo-tenant fallback', async () => {
  const staticIdentitiesJson = JSON.stringify([
    { token: 'orgless-automation-token', subject: 'nightly-job', type: 'service', roles: ['scheduling-assistant'] },
  ]);
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: mockBooking(), staticIdentitiesJson }, async (base) => {
    const res = await book(base, { bookingContext: 'bct_x', startsAt: SEP_TUE_9AM, attendee: ATTENDEE },
      { authorization: 'Bearer orgless-automation-token' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'organization_unresolved');
  });
});

// ── Availability↔booking parity across all three routes ─────────────────────

test('book: availability and booking use the SAME resolved event type — Clay 6287134, Doug 6330128, probate 6330099', async () => {
  const availability = mockAvailability();
  const booking = mockBooking();
  const clock = fixedClock(T0);
  await withServer({ configService: fixtureConfig(), availabilityProvider: availability, bookingProvider: booking, clock }, async (base) => {
    const routes = [
      { request: { attorneyId: 'clay-martinson' }, eventTypeId: 6287134, attributed: 'clay-martinson' },
      { request: { attorneyId: 'doug-martinson' }, eventTypeId: 6330128, attributed: 'doug-martinson' },
      { request: { practiceAreaId: 'probate' }, eventTypeId: 6330099, attributed: undefined },
    ];
    for (const [i, route] of routes.entries()) {
      const offer = await obtainContext(base, route.request);
      assert.equal(availability.calls[i].eventTypeId, route.eventTypeId, 'availability queries the resolved event type');
      const res = await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE });
      assert.equal(res.status, 200);
      const bodyJson = await res.json();
      assert.equal(bodyJson.status, 'booked');
      assert.equal(bodyJson.startsAt, offer.slots[0].startsAt);
      assert.equal(bodyJson.durationMinutes, 30);
      assert.equal(bodyJson.attorneyId, route.attributed);
      assert.equal(booking.calls[i].eventTypeId, route.eventTypeId,
        'booking uses the SAME event type the offered slots came from — parity by construction');
      assert.equal(booking.calls[i].attendee.timeZone, CHI, 'attendee timezone is the tenant timezone');
      assert.equal(booking.calls[i].attendee.language, 'en');
      assert.match(booking.calls[i].metadata.guideherdBookingContextId, /^bc_/,
        'operator correlation carries the context id, never PII beyond the attendee Cal.com already receives');
      assert.notEqual(booking.calls[i].metadata.guideherdBookingContextId, offer.bookingContext,
        'the metadata is the INTERNAL id — the opaque bookingContext value never goes to Cal.com');
      assert.deepEqual(Object.keys(booking.calls[i].metadata), ['guideherdBookingContextId'],
        'no other correlation payload is sent');
      assert.deepEqual(Object.keys(bodyJson).sort(),
        route.attributed ? ['attorneyId', 'durationMinutes', 'startsAt', 'status'] : ['durationMinutes', 'startsAt', 'status'],
        'the envelope exposes no eventTypeId, route internals, hashes, or provider payloads');
    }
    // Walk-in throughout: no sessionId was ever supplied.
    assert.ok(booking.calls.every((c) => c.metadata.sessionId === undefined));
  });
});

// ── Single-use contexts: membership, reuse, expiry, tenancy, concurrency ────

test('book: a timestamp that was never offered is rejected WITHOUT consuming the context; the caller can still book a real slot', async () => {
  const booking = mockBooking();
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking }, async (base) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    const wrong = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: '2026-09-01T16:15:00.000Z', attendee: ATTENDEE,
    })).json();
    assert.deepEqual(wrong, { status: 'rejected', reason: 'timestamp_not_offered' });
    assert.equal(booking.calls.length, 0, 'nothing reached the provider');
    // The context survived — the second (legitimate) slot books fine.
    const ok = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: offer.slots[1].startsAt, attendee: ATTENDEE,
    })).json();
    assert.equal(ok.status, 'booked');
  });
});

test('book: a consumed context is rejected on reuse; an unknown or cross-tenant context is indistinguishable from nonsense', async () => {
  const booking = mockBooking();
  const staticIdentitiesJson = JSON.stringify([
    { token: 'other-firm-assistant-token', subject: 'assistant-b', type: 'service', organizationKey: 'other-firm', roles: ['scheduling-assistant'] },
  ]);
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking, staticIdentitiesJson }, async (base) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    // Another tenant presenting this context learns nothing.
    const foreign = await (await book(base,
      { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE },
      { authorization: 'Bearer other-firm-assistant-token' })).json();
    assert.deepEqual(foreign, { status: 'rejected', reason: 'booking_context_unknown' });
    const gibberish = await (await book(base,
      { bookingContext: 'bct_never-issued', startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(gibberish, { status: 'rejected', reason: 'booking_context_unknown' },
      'cross-tenant and never-issued are the same answer');
    // The rightful tenant books (the foreign attempt consumed nothing) …
    const ok = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.equal(ok.status, 'booked');
    // … and reuse is rejected.
    const reuse = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[1].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(reuse, { status: 'rejected', reason: 'booking_context_used' });
    assert.equal(booking.calls.length, 1, 'exactly one provider booking happened');
  });
});

test('book: two CONCURRENT booking requests on one context — exactly one books, the other is rejected', async () => {
  const booking = mockBooking(async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 20)); // hold the winner in-flight
    return { uid: 'uid_race', sanitized: { uid: 'uid_race', start: args.startsAt } };
  });
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking }, async (base) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    // Fire both BEFORE awaiting either — genuinely concurrent requests.
    const [responseA, responseB] = await Promise.all([
      book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE }),
      book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[1].startsAt, attendee: ATTENDEE }),
    ]);
    const [a, b] = await Promise.all([responseA.json(), responseB.json()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ['booked', 'rejected']);
    assert.equal([a, b].find((r) => r.status === 'rejected').reason, 'booking_context_used');
    assert.equal(booking.calls.length, 1, 'the loser never reached the provider');
  });
});

test('book: an expired context is a controlled expired outcome — never a booking', async () => {
  const clock = fixedClock(T0);
  const booking = mockBooking();
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking, clock }, async (base) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    clock.advance(BOOKING_CONTEXT_TTL_MS + 1);
    const res = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(res, { status: 'expired', reason: 'booking_context_expired' });
    assert.equal(booking.calls.length, 0);
  });
});

// ── Provider-outcome matrix (zero retries; ambiguity is never resolved by guessing) ──

test('book: a DEFINITIVE provider rejection is `rejected` and persists as rejected — the caller is told it did not book', async () => {
  const clock = fixedClock(T0);
  const { lines, telemetry } = captureTelemetry(clock);
  const booking = mockBooking(new BookingRejectedByProviderError(400));
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking, telemetry, clock }, async (base, app) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    const res = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(res, { status: 'rejected', reason: 'provider_rejected' });
    assert.equal(booking.calls.length, 1, 'zero retries');
    const event = lines.find((l) => l.event === 'guideherd.scheduling.booking_rejected');
    assert.equal(event.level, 'warn');
    assert.equal(event.httpStatus, 400);
    const row = await app.bookingContexts.get(event.bookingContextId);
    assert.equal(row.status, BookingContextStatus.REJECTED);
    assert.equal(row.rejectionReason, 'provider_rejected_400');
  });
});

test('book: an AMBIGUOUS provider outcome is verification_required — no retry, no success claim, no failure claim, loud telemetry', async () => {
  const clock = fixedClock(T0);
  const { lines, telemetry } = captureTelemetry(clock);
  const booking = mockBooking(new BookingUnverifiedError('provider_timeout'));
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: booking, telemetry, clock }, async (base, app) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    const res = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(res, { status: 'verification_required', reason: 'provider_timeout' });
    assert.equal(booking.calls.length, 1, 'an ambiguous outcome is NEVER retried — no idempotency mechanism exists');
    const event = lines.find((l) => l.event === 'guideherd.scheduling.booking_verification_required');
    assert.equal(event.level, 'error', 'an operator must investigate — this is never quiet');
    const row = await app.bookingContexts.get(event.bookingContextId);
    assert.equal(row.status, BookingContextStatus.VERIFICATION_REQUIRED);
    assert.equal(row.rejectionReason, 'provider_timeout');
    assert.equal(row.selectedStartsAt, offer.slots[0].startsAt, 'the operator sees exactly what was attempted');
  });
});

test('book: Cal.com CONFIRMS but persistence fails — verification_required, never a booked claim on process memory alone', async () => {
  const clock = fixedClock(T0);
  const inner = createInMemoryBookingContextStore({ clock });
  const store = {
    ...inner,
    async complete(args) {
      if (args.status === BookingContextStatus.BOOKED) throw new Error('database unavailable');
      return inner.complete(args);
    },
  };
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: mockBooking(), bookingContextStore: store, clock }, async (base, app) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    const res = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(res, { status: 'verification_required', reason: 'booked_result_persistence_failed' });
  });
});

test('book: an unconfigured booking provider is a controlled rejection BEFORE the claim — the context stays claimable', async () => {
  // The default provider composes from the environment; without
  // CALCOM_API_KEY it reports configured=false.
  const unconfigured = createCalcomBookingProvider({ apiKey: null });
  assert.equal(unconfigured.configured, false);
  const clock = fixedClock(T0);
  const { lines, telemetry } = captureTelemetry(clock);
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: unconfigured, telemetry, clock }, async (base, app) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    const res = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.deepEqual(res, { status: 'rejected', reason: 'booking_not_configured' });
    // Nothing was consumed: the row is still claimable after the fix.
    const offeredEvent = lines.find((l) => l.event === 'guideherd.scheduling.slots_offered');
    const row = await app.bookingContexts.get(offeredEvent.bookingContextId);
    assert.equal(row.status, BookingContextStatus.OFFERED);
  });
});

// ── Secret hygiene ──────────────────────────────────────────────────────────

test('book: the raw bookingContext value appears in NO telemetry event — only the bc_ context id does', async () => {
  const clock = fixedClock(T0);
  const { lines, telemetry } = captureTelemetry(clock);
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: mockBooking(), telemetry, clock }, async (base) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson', sessionId: 'sess-hygiene' });
    const res = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE, sessionId: 'sess-hygiene',
    })).json();
    assert.equal(res.status, 'booked');
    const serialized = JSON.stringify(lines);
    assert.ok(!serialized.includes(offer.bookingContext), 'the opaque value never reaches telemetry');
    assert.ok(!serialized.includes(ATTENDEE.email), 'attendee PII never reaches telemetry');
    const created = lines.find((l) => l.event === 'guideherd.scheduling.booking_created');
    assert.match(created.bookingContextId, /^bc_/);
    assert.equal(created.sessionId, 'sess-hygiene');
    assert.equal(created.routeKind, 'attorney');
  });
});

// ── Cal.com booking client contract ─────────────────────────────────────────

test('calcom booking client: ONE request, proven api version, tenant metadata, uid extraction — and the full outcome classification', async () => {
  const calls = [];
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
  const clientWith = (impl) => createCalcomBookingProvider({ apiKey: 'k', fetchImpl: impl });
  const args = {
    eventTypeId: 6330128,
    startsAt: SEP_TUE_9AM,
    attendee: { name: 'Pat', email: 'pat@example.com', timeZone: CHI, language: 'en' },
    metadata: { guideherdBookingContextId: 'bc_meta' },
  };

  // Confirmed success: exact request shape, uid + sanitized subset back.
  const ok = await clientWith(async (url, options) => {
    calls.push({ url, options });
    return respond(201, { status: 'success', data: { uid: 'uid_9', start: SEP_TUE_9AM, status: 'accepted', attendee: { secret: 'never-copied' } } });
  }).createBooking(args);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cal.com/v2/bookings');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['cal-api-version'], BOOKING_CAL_API_VERSION);
  assert.equal(BOOKING_CAL_API_VERSION, '2024-08-13', 'the version the live working integration uses');
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(sent).sort(), ['attendee', 'eventTypeId', 'metadata', 'start']);
  assert.equal(sent.eventTypeId, 6330128);
  assert.deepEqual(ok, { uid: 'uid_9', sanitized: { uid: 'uid_9', start: SEP_TUE_9AM, status: 'accepted' } });

  // 4xx: definitive rejection. 5xx / bad JSON / missing uid / error
  // envelope / network / timeout: per the matrix.
  await assert.rejects(() => clientWith(async () => respond(400, {})).createBooking(args),
    (err) => err instanceof BookingRejectedByProviderError && err.httpStatus === 400);
  await assert.rejects(() => clientWith(async () => respond(200, { status: 'error', error: { message: 'no' } })).createBooking(args),
    (err) => err instanceof BookingRejectedByProviderError && err.httpStatus === 200);
  await assert.rejects(() => clientWith(async () => respond(503, {})).createBooking(args),
    (err) => err instanceof BookingUnverifiedError && err.detail === 'provider_http_503');
  await assert.rejects(() => clientWith(async () => respond(201, { status: 'success', data: {} })).createBooking(args),
    (err) => err instanceof BookingUnverifiedError && err.detail === 'missing_booking_uid');
  await assert.rejects(() => clientWith(async () => ({ ok: true, status: 201, async json() { throw new Error('bad json'); } })).createBooking(args),
    (err) => err instanceof BookingUnverifiedError && err.detail === 'unparseable_success_body');
  await assert.rejects(() => clientWith(async () => { throw new TypeError('socket hang up'); }).createBooking(args),
    (err) => err instanceof BookingUnverifiedError && err.detail === 'network_failure');

  // Hard timeout via AbortController — ambiguous, never retried.
  let fetches = 0;
  const timingOut = createCalcomBookingProvider({
    apiKey: 'k',
    timeoutMs: 120,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      fetches += 1;
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      });
    }),
  });
  await assert.rejects(() => timingOut.createBooking(args),
    (err) => err instanceof BookingUnverifiedError && err.detail === 'provider_timeout');
  assert.equal(fetches, 1, 'zero retries');

  // The timeout budget is clamped to the booking maximum.
  assert.equal(clampBookingTimeoutMs(60_000), MAX_BOOKING_TIMEOUT_MS);
  assert.equal(clampBookingTimeoutMs(undefined), 2500);
  assert.equal(clampBookingTimeoutMs(1), 100);
});

test('book: the STORE never sees the raw bookingContext — only its 64-hex SHA-256 hash', async () => {
  const clock = fixedClock(T0);
  const inner = createInMemoryBookingContextStore({ clock });
  const created = [];
  const store = { ...inner, async create(context) { created.push(context); return inner.create(context); } };
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: mockBooking(), bookingContextStore: store, clock }, async (base) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    assert.equal(created.length, 1);
    assert.match(created[0].contextTokenHash, /^[0-9a-f]{64}$/, 'the store receives a SHA-256 hash');
    assert.ok(!JSON.stringify(created[0]).includes(offer.bookingContext), 'the raw value never reaches the repository');
  });
});

test('book: TOTAL persistence failure after a confirmed booking strands the row — and a later reconciliation pass surfaces it', async () => {
  const clock = fixedClock(T0);
  const inner = createInMemoryBookingContextStore({ clock });
  const store = { ...inner, async complete() { throw new Error('database unavailable'); } };
  const { lines, telemetry } = captureTelemetry(clock);
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: mockBooking(), bookingContextStore: store, telemetry, clock }, async (base, app) => {
    const offer = await obtainContext(base, { attorneyId: 'clay-martinson' });
    const res = await (await book(base, { bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE })).json();
    assert.equal(res.status, 'verification_required', 'never booked on process memory alone');
    // The row is stranded in booking_in_progress (nothing could persist).
    const offeredEvent = lines.find((l) => l.event === 'guideherd.scheduling.slots_offered');
    assert.equal((await inner.get(offeredEvent.bookingContextId)).status, BookingContextStatus.BOOKING_IN_PROGRESS);
    // A later reconciliation tick — after the store recovers — flips it
    // loudly (complete() is not involved; reconcileStale acts directly).
    clock.advance(3 * 60 * 1000);
    const flipped = await app.reconcileBookingContexts();
    assert.equal(flipped.length, 1);
    assert.equal((await inner.get(offeredEvent.bookingContextId)).status, BookingContextStatus.VERIFICATION_REQUIRED);
  });
});

test('reconciliation: a repository failure is VISIBLE telemetry, resolves without throwing, and marks nothing booked or rejected', async () => {
  const clock = fixedClock(T0);
  const inner = createInMemoryBookingContextStore({ clock });
  let broken = true;
  const store = {
    ...inner,
    async reconcileStale(args) {
      if (broken) throw new Error('connection refused');
      return inner.reconcileStale(args);
    },
  };
  const { lines, telemetry } = captureTelemetry(clock);
  await withServer({ configService: fixtureConfig(), availabilityProvider: mockAvailability(), bookingProvider: mockBooking(new BookingUnverifiedError('never-called')), bookingContextStore: store, telemetry, clock }, async (base, app) => {
    // A genuinely stranded row exists.
    await inner.create({
      bookingContextId: 'bc_stuck', contextTokenHash: 'a'.repeat(64), organizationKey: FIRM,
      sessionId: null, routeKind: 'default', attorneyId: null, routingGroupKey: null,
      consultationTypeId: null, eventTypeId: 6287134, durationMinutes: 30,
      offeredSlots: [SEP_TUE_9AM], createdAtMs: T0, expiresAtMs: T0 + BOOKING_CONTEXT_TTL_MS,
    });
    await inner.claim({ bookingContextId: 'bc_stuck', startsAt: SEP_TUE_9AM });
    clock.advance(3 * 60 * 1000);
    // The failing pass: no throw, loud telemetry, row untouched.
    assert.deepEqual(await app.reconcileBookingContexts(), []);
    const failure = lines.find((l) => l.event === 'guideherd.internal.unexpected_error');
    assert.equal(failure.component, 'scheduling');
    assert.equal(failure.operation, 'booking-reconciliation');
    assert.equal(failure.level, 'error');
    assert.ok(!JSON.stringify(failure).includes('a'.repeat(64)), 'no token hash in the failure event');
    assert.equal((await inner.get('bc_stuck')).status, BookingContextStatus.BOOKING_IN_PROGRESS,
      'a failed reconciliation never invents an outcome');
    // The NEXT poller tick, with the store recovered, completes the job.
    broken = false;
    const flipped = await app.reconcileBookingContexts();
    assert.deepEqual(flipped.map((c) => c.bookingContextId), ['bc_stuck']);
    assert.equal((await inner.get('bc_stuck')).status, BookingContextStatus.VERIFICATION_REQUIRED);
  });
});

// ── Startup reconciliation ──────────────────────────────────────────────────

test('reconciliation: a stranded booking_in_progress row flips LOUDLY to verification_required at boot', async () => {
  const clock = fixedClock(T0);
  const store = createInMemoryBookingContextStore({ clock });
  const { lines, telemetry } = captureTelemetry(clock);
  await store.create({
    bookingContextId: 'bc_stranded', contextTokenHash: 'h'.repeat(64), organizationKey: FIRM,
    sessionId: 'sess-crash', routeKind: 'attorney', attorneyId: 'clay-martinson',
    consultationTypeId: null, eventTypeId: 6287134, durationMinutes: 30,
    offeredSlots: [SEP_TUE_9AM], createdAtMs: T0, expiresAtMs: T0 + BOOKING_CONTEXT_TTL_MS,
  });
  await store.claim({ bookingContextId: 'bc_stranded', startsAt: SEP_TUE_9AM });
  clock.advance(3 * 60 * 1000); // the process died; a new boot reconciles
  const flipped = await reconcileStaleBookingContexts({ bookingContexts: store, telemetry });
  assert.equal(flipped.length, 1);
  assert.equal((await store.get('bc_stranded')).status, BookingContextStatus.VERIFICATION_REQUIRED);
  const event = lines.find((l) => l.event === 'guideherd.scheduling.booking_verification_required');
  assert.equal(event.bookingContextId, 'bc_stranded');
  assert.equal(event.code, 'stale_booking_in_progress');
});
