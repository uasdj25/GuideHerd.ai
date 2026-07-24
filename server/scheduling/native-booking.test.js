'use strict';

/**
 * Native governed booking, endpoint to calendar (GitLab #79/#80): the
 * per-tenant provider selection, the unchanged tool-facing contracts,
 * booking landing on the ATTRIBUTED calendar, the double-booking guard,
 * the just-before-create re-check, ambiguity -> verification_required
 * with correlation-based recoverability, audit history, and legacy-path
 * isolation. Everything runs against the reference calendar provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createReferenceCalendarProvider } = require('./calendar-provider');

const FIRM = 'martinson-beason';
const SECRET = 'demo-secret-for-tests-only';
const T0 = Date.parse('2026-08-30T15:15:00Z');
const CHI = 'America/Chicago';
const HOURS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opens: '09:00', closes: '17:00' }));
const SEP_TUE_9AM = '2026-09-01T14:00:00.000Z';
const SEP_TUE_930AM = '2026-09-01T14:30:00.000Z';
const WEEK = { dateFrom: '2026-09-01', dateTo: '2026-09-05' };
const ATTENDEE = { name: 'Pat Caller', email: 'pat@example.com', phoneNumber: '+12565550100' };

function nativeFixture({ targets } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: CHI });
  configService.locations.create(FIRM, { key: 'huntsville', name: 'Huntsville Office', timezone: CHI, officeHours: HOURS });
  for (const key of ['clay-martinson', 'doug-martinson']) {
    configService.providers.create(FIRM, { key, name: key, active: true });
  }
  configService.serviceAreas.create(FIRM, { key: 'probate', name: 'Probate', active: true });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', active: true });
  configService.routingGroups.create(FIRM, {
    key: 'probate', name: 'Probate', serviceArea: 'probate', active: true,
    providers: ['clay-martinson', 'doug-martinson'],
  });
  configService.settings.set(FIRM, 'scheduling', 'calendar-targets', targets ?? {
    provider: 'reference',
    attorneyCalendars: { 'clay-martinson': 'cal-clay', 'doug-martinson': 'cal-doug' },
    schedulableAttorneys: ['clay-martinson', 'doug-martinson'],
  });
  const provider = createReferenceCalendarProvider();
  provider.givenCalendar('cal-clay', {});
  provider.givenCalendar('cal-doug', {});
  return { configService, provider };
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
const post = (base, path_, body) => fetch(base + path_, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
});
const offered = (base, body) => post(base, '/api/v1/scheduling/offered-slots', body);
const book = (base, body) => post(base, '/api/v1/scheduling/book', body);

test('native endpoint: the offered-slots contract is byte-compatible — same keys, two slots, opaque context', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base) => {
    const res = await offered(base, { ...WEEK, attorneyId: 'clay-martinson' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['bookingContext', 'slots', 'status', 'window'],
      'the tool-facing schema is unchanged');
    assert.equal(body.status, 'offered');
    assert.equal(body.slots.length, 2);
    assert.match(body.bookingContext, /^bct_[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(body.slots[0], { startsAt: SEP_TUE_9AM, durationMinutes: 30, attorneyId: 'clay-martinson' });
  });
});

test('native endpoint: booked lands the event on the routed calendar with the context correlation', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base, app) => {
    const offer = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    const res = await book(base, {
      bookingContext: offer.bookingContext, startsAt: offer.slots[0].startsAt, attendee: ATTENDEE,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      status: 'booked', startsAt: SEP_TUE_9AM, durationMinutes: 30, attorneyId: 'clay-martinson',
    }, 'the tool-facing booked envelope is unchanged');

    const events = fx.provider.eventsOn('cal-clay');
    assert.equal(events.length, 1);
    assert.match(events[0].correlationId, /^bc_/, 'the event carries the booking-context correlation');
    assert.equal(events[0].startsAt, SEP_TUE_9AM);
    assert.equal(fx.provider.eventsOn('cal-doug').length, 0);

    // Durable row: booked with the provider event id; audit trail complete.
    const context = await app.bookingContexts.get(events[0].correlationId);
    assert.equal(context.status, 'booked');
    assert.equal(context.providerEventId, events[0].providerEventId);
    assert.equal(context.providerKey, 'reference');
    const trail = await app.schedulingAudit.listByContext(events[0].correlationId);
    assert.deepEqual(trail.map((r) => r.action), ['created', 'claimed', 'booked']);
  });
});

test('native endpoint: a practice-area booking lands on the ATTRIBUTED attorney\'s calendar', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base) => {
    const offer = await (await offered(base, { ...WEEK, practiceAreaId: 'probate' })).json();
    // Balanced attribution: 09:00 -> clay, 09:30 -> doug.
    const dougSlot = offer.slots.find((s) => s.attorneyId === 'doug-martinson');
    assert.ok(dougSlot, 'the pool offer attributes both attorneys');
    const body = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: dougSlot.startsAt, attendee: ATTENDEE,
    })).json();
    assert.equal(body.status, 'booked');
    assert.equal(body.attorneyId, 'doug-martinson');
    assert.equal(fx.provider.eventsOn('cal-doug').length, 1, 'booked on the attributed calendar');
    assert.equal(fx.provider.eventsOn('cal-clay').length, 0);
  });
});

test('native endpoint: the slot guard — the same calendar+instant books once; the loser keeps its other option', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base) => {
    const offerA = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    const offerB = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    assert.equal((await (await book(base, {
      bookingContext: offerA.bookingContext, startsAt: SEP_TUE_9AM, attendee: ATTENDEE,
    })).json()).status, 'booked');

    const lost = await (await book(base, {
      bookingContext: offerB.bookingContext, startsAt: SEP_TUE_9AM, attendee: ATTENDEE,
    })).json();
    assert.deepEqual(lost, { status: 'rejected', reason: 'slot_no_longer_available' });
    assert.equal(fx.provider.attempts('createEvent'), 1, 'the loser never reached the provider');

    // NOT consumed: the loser's context can still book its other offered slot.
    const second = await (await book(base, {
      bookingContext: offerB.bookingContext, startsAt: SEP_TUE_930AM, attendee: ATTENDEE,
    })).json();
    assert.equal(second.status, 'booked');
    assert.equal(fx.provider.eventsOn('cal-clay').length, 2);
  });
});

test('native endpoint: a provider-side conflict is caught by the just-before-create re-check', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base) => {
    const offer = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    // Someone books the attorney's calendar DIRECTLY (outside GuideHerd).
    await fx.provider.createEvent({
      calendarRef: 'cal-clay', startsAt: SEP_TUE_9AM, durationMinutes: 30,
      summary: 'External meeting', correlationId: 'bc_external-event',
    });
    const body = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: SEP_TUE_9AM, attendee: ATTENDEE,
    })).json();
    assert.deepEqual(body, { status: 'rejected', reason: 'slot_no_longer_available' });
    assert.equal(fx.provider.attempts('createEvent'), 1, 'only the external create ever ran');
  });
});

test('native endpoint: an unreadable re-check rejects WITHOUT attempting the provider write', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base) => {
    const offer = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    fx.provider.injectFailure('fetchBusyIntervals', 'timeout');
    const body = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: SEP_TUE_9AM, attendee: ATTENDEE,
    })).json();
    assert.deepEqual(body, { status: 'rejected', reason: 'availability_recheck_failed' });
    assert.equal(fx.provider.attempts('createEvent'), 0,
      'no write attempted -> definitively NOT booked, never ambiguous');
  });
});

test('native endpoint: an ambiguous create is verification_required and recoverable by correlation', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base, app) => {
    const offer = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    fx.provider.injectFailure('createEvent', 'ambiguous_created');
    const body = await (await book(base, {
      bookingContext: offer.bookingContext, startsAt: SEP_TUE_9AM, attendee: ATTENDEE,
    })).json();
    assert.equal(body.status, 'verification_required');
    assert.equal(fx.provider.attempts('createEvent'), 1, 'an ambiguous write is NEVER retried');

    // The event actually exists — reconciliation proves it by correlation.
    const event = fx.provider.eventsOn('cal-clay')[0];
    const context = await app.bookingContexts.get(event.correlationId);
    assert.equal(context.status, 'verification_required');
    const found = await fx.provider.findEventByCorrelation({
      calendarRef: 'cal-clay', correlationId: event.correlationId,
    });
    assert.equal(found.providerEventId, event.providerEventId);
  });
});

test('native endpoint: a selected-but-unregistered provider fails closed as 503 configuration', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: {} }, async (base) => {
    const res = await offered(base, { ...WEEK, attorneyId: 'clay-martinson' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'availability_not_configured');
  });
});

test('native endpoint: a native provider read failure is 502, never a raw-slot fallback', async () => {
  const fx = nativeFixture();
  await withServer({ configService: fx.configService, calendarProviders: { reference: fx.provider } }, async (base) => {
    fx.provider.injectFailure('fetchBusyIntervals', 'timeout');
    const res = await offered(base, { ...WEEK, attorneyId: 'clay-martinson' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'calendar_unavailable');
  });
});

test('native endpoint: provider selection is tenant configuration — a legacy tenant never touches the native path', async () => {
  // Same deployment, calendarProviders registered, but the tenant has NO
  // calendar-targets document: the legacy Cal.com path serves it, byte
  // for byte as before.
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: CHI });
  configService.locations.create(FIRM, { key: 'huntsville', name: 'Huntsville', timezone: CHI, officeHours: HOURS });
  configService.providers.create(FIRM, { key: 'clay-martinson', name: 'Clay', active: true });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial', active: true });
  configService.settings.set(FIRM, 'scheduling', 'calcom-availability', {
    eventTypeId: 6287134, attorneyEventTypes: { 'clay-martinson': 6287134 }, durationMinutes: 30,
  });
  const legacyAvailability = {
    calls: [],
    key: 'mock',
    timeoutMs: 1200,
    async fetchAvailability(args) { this.calls.push(args); return { slots: [{ startsAt: SEP_TUE_9AM }] }; },
  };
  const nativeProvider = createReferenceCalendarProvider();
  await withServer({
    configService,
    availabilityProvider: legacyAvailability,
    calendarProviders: { reference: nativeProvider },
  }, async (base) => {
    const body = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    assert.equal(body.status, 'offered');
    assert.equal(legacyAvailability.calls.length, 1, 'the legacy provider served the check');
    assert.equal(legacyAvailability.calls[0].eventTypeId, 6287134);
    assert.equal(nativeProvider.attempts('fetchBusyIntervals'), 0, 'the native provider was never consulted');
  });
});
