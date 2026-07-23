'use strict';

/**
 * Consolidated offered-slots tests: the single small request through
 * which the conversation layer obtains appointment options — the model
 * never transports slot batches. Covers request validation, tenant
 * authorization (no demo fallback), cross-tenant isolation, SQLite-only
 * configuration, tenant-local window semantics (including DST), Cal.com
 * request construction and bounded timeouts, ranking reuse without
 * pre-ranking truncation, the two-slot model-facing cap, fail-closed
 * failure policy (no raw-slot fallback), timing telemetry, diagnostic
 * bypass detection, and local processing time at representative volumes.
 * The preserved Issue #66 downstream behavior is asserted where it
 * touches this seam; the capability itself is platform work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { createTelemetry } = require('../telemetry/telemetry');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const {
  createCalcomAvailabilityProvider,
  clampTimeoutMs,
  AvailabilityTimeoutError,
  AvailabilityProviderError,
  AvailabilityMalformedError,
  AvailabilityNotConfiguredError,
  parseCalcomSlots,
  MAX_TIMEOUT_MS,
} = require('./availability');
const { localWindowUtc, localMidnightUtcMs, MAX_OFFERED_TO_AGENT } = require('./offered-slots');

const FIRM = 'martinson-beason';
const SECRET = 'demo-secret-for-tests-only';
const T0 = Date.parse('2026-08-30T15:15:00Z');
const CHI = 'America/Chicago';
const HOURS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opens: '09:00', closes: '17:00' }));

// 2026-09-01 is a Tuesday; the "first week of September" window.
const SEP_TUE_9AM = '2026-09-01T14:00:00.000Z';   // 09:00 local
const SEP_TUE_2PM = '2026-09-01T19:00:00.000Z';   // 14:00 local
const SEP_TUE_8PM = '2026-09-02T01:00:00.000Z';   // 20:00 local Sep 1 — outside hours
const SEP_WED_10AM = '2026-09-02T15:00:00.000Z';  // 10:00 local

function fixtureConfig({ policy, calcom } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: CHI });
  configService.locations.create(FIRM, { key: 'huntsville', name: 'Huntsville Office', timezone: CHI, officeHours: HOURS });
  // Catalog entities: routing inputs must reference real, active entries.
  for (const key of ['clay-martinson', 'doug-martinson', 'raina-baugher']) {
    configService.providers.create(FIRM, { key, name: key, active: true });
  }
  configService.providers.create(FIRM, { key: 'retired-attorney', name: 'Retired', active: false });
  for (const key of ['probate', 'personal-injury', 'family-law']) {
    configService.serviceAreas.create(FIRM, { key, name: key, active: true });
  }
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', active: true });
  // The probate routing group: membership is the tenant's configured
  // attorney-eligibility policy for the practice area.
  configService.routingGroups.create(FIRM, {
    key: 'probate', name: 'Probate', serviceArea: 'probate', active: true,
    providers: ['clay-martinson', 'doug-martinson'],
  });
  if (policy) configService.settings.set(FIRM, 'scheduling', 'policy', policy);
  if (calcom !== null) {
    configService.settings.set(FIRM, 'scheduling', 'calcom-availability',
      calcom || {
        eventTypeId: 111,
        attorneyEventTypes: { 'clay-martinson': 222 },
        routingGroupEventTypes: { probate: 333 },
        durationMinutes: 30,
      });
  }
  return configService;
}

/** A scripted availability provider; records every fetch it serves. */
function mockProvider(behavior) {
  const calls = [];
  return {
    calls,
    key: 'mock',
    timeoutMs: 1200,
    async fetchAvailability(args) {
      calls.push(args);
      const result = typeof behavior === 'function' ? behavior(args) : behavior;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function captureTelemetry() {
  const lines = [];
  return { lines, telemetry: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) }) };
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
const WEEK = { dateFrom: '2026-09-01', dateTo: '2026-09-07' };

// ── Request validation and authorization ────────────────────────────────────

test('offered-slots: request validation — dates required and bounded; optional fields stay optional; no slot arrays', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
  await withServer({ configService: fixtureConfig(), availabilityProvider: provider }, async (base) => {
    assert.equal((await offered(base, {})).status, 400);
    assert.equal((await offered(base, { dateFrom: 'Sept 1', dateTo: '2026-09-07' })).status, 400);
    assert.equal((await offered(base, { dateFrom: '2026-09-07', dateTo: '2026-09-01' })).status, 400, 'reversed window');
    assert.equal((await offered(base, { dateFrom: '2026-09-01', dateTo: '2026-10-15' })).status, 400, 'window over the cap');
    assert.equal((await offered(base, { ...WEEK, slots: [] })).status, 400, 'slot arrays are NOT accepted — the model never sends slots');
    assert.equal((await offered(base, { ...WEEK, durationMinutes: 'thirty' })).status, 400);
    assert.equal(provider.calls.length, 0, 'no provider call for an invalid request');

    // Minimal valid request: only the window — nothing fabricated.
    const minimal = await (await offered(base, WEEK)).json();
    assert.equal(minimal.status, 'offered');
    assert.equal(minimal.slots[0].durationMinutes, 30, 'duration defaults from configuration');

    assert.equal((await offered(base, WEEK, {})).status, 401);
    assert.equal((await offered(base, WEEK, { authorization: 'Bearer wrong' })).status, 403);
  });
});

test('offered-slots: an authenticated identity WITHOUT an organization is refused — no demo-tenant fallback', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
  const staticIdentitiesJson = JSON.stringify([
    { token: 'orgless-automation-token', subject: 'nightly-job', type: 'service', roles: ['scheduling-assistant'] },
  ]);
  await withServer({ configService: fixtureConfig(), availabilityProvider: provider, staticIdentitiesJson }, async (base) => {
    const res = await offered(base, WEEK, { authorization: 'Bearer orgless-automation-token' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'organization_unresolved');
    assert.equal(provider.calls.length, 0, 'no tenant configuration is ever resolved for an unscoped identity');
  });
});

test('offered-slots: cross-tenant isolation — an identity resolves only its OWN tenant\'s calendar configuration', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
  const configService = fixtureConfig(); // martinson-beason -> eventTypeId 111
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: CHI });
  configService.locations.create('other-firm', { key: 'main', name: 'Main', timezone: CHI, officeHours: HOURS });
  configService.settings.set('other-firm', 'scheduling', 'calcom-availability', { eventTypeId: 999, durationMinutes: 30 });
  const staticIdentitiesJson = JSON.stringify([
    { token: 'other-firm-assistant-token', subject: 'assistant-b', type: 'service', organizationKey: 'other-firm', roles: ['scheduling-assistant'] },
  ]);
  await withServer({ configService, availabilityProvider: provider, staticIdentitiesJson }, async (base) => {
    await offered(base, WEEK, { authorization: 'Bearer other-firm-assistant-token' });
    assert.equal(provider.calls[0].eventTypeId, 999, 'other-firm identity queries other-firm\'s event type');
    await offered(base, WEEK); // the demo-bridge identity is scoped to martinson-beason
    assert.equal(provider.calls[1].eventTypeId, 111, 'the demo identity queries only the demo tenant\'s event type');
  });
});

test('offered-slots: tenant configuration comes from SQLite — absent Cal.com config fails closed, never guesses', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
  await withServer({ configService: fixtureConfig({ calcom: null }), availabilityProvider: provider }, async (base) => {
    const res = await offered(base, WEEK);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'availability_not_configured');
    assert.equal(provider.calls.length, 0);
  });
});

test('offered-slots: the Martinson & Beason seed carries the ESTABLISHED Cal.com event type — never a placeholder', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'data', 'martinson-beason.example.json'), 'utf8'));
  const calcom = seed.settings.find((s) => s.key === 'calcom-availability');
  // The three live mappings were read back from the deployed Create
  // Booking integration during the Gate 10 inspection (2026-07-22) and
  // are treated as established production configuration: 6287134 (Clay
  // Martinson / Initial Consultation, also the explicit default path),
  // 6330128 (Doug Martinson), 6330099 (probate round-robin group).
  // Booking parity is now structural — booking reads the event type from
  // the same durable routing decision that produced the offered slots.
  assert.deepEqual(calcom.value, {
    eventTypeId: 6287134,
    attorneyEventTypes: { 'clay-martinson': 6287134, 'doug-martinson': 6330128 },
    routingGroupEventTypes: { probate: 6330099 },
    durationMinutes: 30,
  });
  assert.ok(!JSON.stringify(seed).includes('123456'), 'no placeholder id anywhere in the tenant artifact');
  // The mapped keys are real catalog entries in the same seed.
  assert.ok(seed.providers.some((p) => p.key === 'clay-martinson' && p.active));
  assert.ok(seed.providers.some((p) => p.key === 'doug-martinson' && p.active));
  assert.ok(seed.routingGroups.some((g) => g.key === 'probate' && g.active
    && g.providers.includes('clay-martinson') && g.providers.includes('doug-martinson')));
});

test('calcom-availability domain: producer-gate cross-entity validation — mappings must reference real, active, unambiguous catalog entities', () => {
  const { validateDomain } = require('../configuration/framework');
  const configService = fixtureConfig();
  const context = { configService, organizationKey: FIRM };
  const base = {
    eventTypeId: 111,
    attorneyEventTypes: { 'clay-martinson': 222 },
    routingGroupEventTypes: { probate: 333 },
    durationMinutes: 30,
  };
  assert.equal(validateDomain('calcom-availability', base, context).ok, true);

  const issueOf = (doc) => validateDomain('calcom-availability', doc, context).issues.join(' | ');
  assert.match(issueOf({ ...base, attorneyEventTypes: { 'no-such-attorney': 1 } }), /unknown attorney/);
  assert.match(issueOf({ ...base, attorneyEventTypes: { 'retired-attorney': 1 } }), /not active/);
  assert.match(issueOf({ ...base, routingGroupEventTypes: { 'no-such-group': 1 } }), /unknown routing group/);
  assert.match(issueOf({ ...base, eventTypeId: 2 ** 53 }), /positive safe integer/);
  assert.match(issueOf({ ...base, attorneyEventTypes: { 'clay-martinson': 2 ** 53 + 2 } }), /positive safe integer/);

  // A SECOND active group on the same service area makes the mapped
  // group ambiguous for practice-area resolution — rejected at write.
  configService.routingGroups.create(FIRM, {
    key: 'probate-overflow', name: 'Probate Overflow', serviceArea: 'probate', active: true,
    providers: ['doug-martinson'],
  });
  assert.match(issueOf(base), /ambiguous/);

  // Without producer context the cross-entity rules are skipped (the
  // consumer read stays fail-safe); runtime resolution independently
  // fails closed on any unknown key.
  assert.equal(validateDomain('calcom-availability', base, {}).ok, true);
});

// ── Tenant-local window semantics ───────────────────────────────────────────

test('window: dateFrom/dateTo are INCLUSIVE tenant-local calendar days — UTC drift never gains or loses a day', () => {
  // Sep 1 in Chicago (CDT, UTC-5): local day = [05:00Z Sep 1, 05:00Z Sep 2).
  const sep1 = localWindowUtc('2026-09-01', '2026-09-01', CHI);
  assert.equal(new Date(sep1.startUtcMs).toISOString(), '2026-09-01T05:00:00.000Z');
  assert.equal(new Date(sep1.endUtcMs).toISOString(), '2026-09-02T05:00:00.000Z');

  // Month boundary: Sep 30 ends where Oct 1 begins, tenant-local.
  const monthEnd = localWindowUtc('2026-09-28', '2026-09-30', CHI);
  assert.equal(new Date(monthEnd.endUtcMs).toISOString(), '2026-10-01T05:00:00.000Z');

  // A range ending on a Sunday still covers the whole Sunday.
  const sunday = localWindowUtc('2026-09-01', '2026-09-06', CHI);
  assert.equal(new Date(sunday.endUtcMs).toISOString(), '2026-09-07T05:00:00.000Z');

  // DST fall-back (2026-11-01 in America/Chicago): that local day is 25
  // hours long — the window reflects it exactly (05:00Z -> 06:00Z next day).
  const dst = localWindowUtc('2026-11-01', '2026-11-01', CHI);
  assert.equal(new Date(dst.startUtcMs).toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(new Date(dst.endUtcMs).toISOString(), '2026-11-02T06:00:00.000Z');
  assert.equal(dst.endUtcMs - dst.startUtcMs, 25 * 3600 * 1000, 'a 25-hour local day, never plain UTC arithmetic');

  // DST spring-forward (2026-03-08): a 23-hour local day.
  const spring = localWindowUtc('2026-03-08', '2026-03-08', CHI);
  assert.equal(spring.endUtcMs - spring.startUtcMs, 23 * 3600 * 1000);

  assert.throws(() => localMidnightUtcMs('2026-09-01', 'Not/AZone'), /Invalid time zone|invalid/i, 'unknown timezone fails closed');
});

test('window: a tenant-local evening slot stays in its local day, and the provider cannot smuggle out-of-window slots', async () => {
  // 18:30 local Sep 1 = 23:30Z Sep 1; 19:30 local Sep 1 = 00:30Z Sep 2 —
  // BOTH belong to local Sep 1. 18:30 local Aug 31 does not.
  const evening = '2026-09-01T23:30:00.000Z';      // 18:30 local Sep 1 (outside 9-5 hours, but in-window)
  const lateEvening = '2026-09-02T00:30:00.000Z';  // 19:30 local Sep 1
  const aug31 = '2026-08-31T21:00:00.000Z';        // 16:00 local Aug 31 — provider noise outside the window
  const inDay = SEP_TUE_2PM;                        // 14:00 local Sep 1
  const provider = mockProvider({ slots: [{ startsAt: aug31 }, { startsAt: inDay }, { startsAt: evening }, { startsAt: lateEvening }] });
  const { lines, telemetry } = captureTelemetry();
  await withServer({ configService: fixtureConfig(), availabilityProvider: provider, telemetry }, async (base) => {
    const res = await (await offered(base, { dateFrom: '2026-09-01', dateTo: '2026-09-01' })).json();
    // Hours then exclude the evening slots; the Aug 31 slot was excluded by the WINDOW, not hours.
    assert.deepEqual(res.slots.map((s) => s.startsAt), [inDay]);
    const event = lines.find((l) => l.event === 'guideherd.scheduling.slots_offered');
    assert.equal(event.receivedCount, 4);
    assert.equal(event.inWindowCount, 3, 'the out-of-window provider slot is filtered before anything else sees it');
    // And the provider was queried with the exact local-day bounds.
    assert.equal(new Date(provider.calls[0].startUtcMs).toISOString(), '2026-09-01T05:00:00.000Z');
    assert.equal(new Date(provider.calls[0].endUtcMs).toISOString(), '2026-09-02T05:00:00.000Z');
  });
});

// ── Attorney/event resolution and duration propagation ──────────────────────

test('offered-slots: routing — mapped attorney, routing group, explicit default; every unmapped or ineligible path FAILS CLOSED', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
  await withServer({ configService: fixtureConfig(), availabilityProvider: provider }, async (base) => {
    // Mapped attorney -> that attorney's event type, slots attributed.
    const mapped = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).json();
    assert.equal(provider.calls[0].eventTypeId, 222);
    assert.equal(mapped.slots[0].attorneyId, 'clay-martinson');

    // Practice area -> the single active routing group's event type,
    // slots UNATTRIBUTED (the round-robin calendar assigns the host).
    const grouped = await (await offered(base, { ...WEEK, practiceAreaId: 'probate' })).json();
    assert.equal(provider.calls[1].eventTypeId, 333);
    assert.ok(!('attorneyId' in grouped.slots[0]), 'attribution is never fabricated');

    // Attorney + practice area: honored only when the attorney belongs
    // to the area's routing group AND is mapped.
    const permitted = await (await offered(base, { ...WEEK, attorneyId: 'clay-martinson', practiceAreaId: 'probate' })).json();
    assert.equal(provider.calls[2].eventTypeId, 222, 'permitted attorney override wins over the group');
    assert.equal(permitted.slots[0].attorneyId, 'clay-martinson');

    // No context -> the EXPLICITLY configured default path.
    await offered(base, WEEK);
    assert.equal(provider.calls[3].eventTypeId, 111);
    assert.equal(provider.calls.length, 4, 'one bounded fetch per availability check — never a fan-out');

    // FAIL CLOSED (503 routing_unresolved; no provider call, no times):
    // an unmapped attorney is never silently rebooked onto the default
    // calendar; an attorney outside the area's group is ineligible; an
    // unmapped practice area cannot be guessed.
    const unmapped = await offered(base, { ...WEEK, attorneyId: 'raina-baugher' });
    assert.equal(unmapped.status, 503);
    assert.equal((await unmapped.json()).error.code, 'routing_unresolved');
    const notPermitted = await offered(base, { ...WEEK, attorneyId: 'raina-baugher', practiceAreaId: 'probate' });
    assert.equal(notPermitted.status, 503, 'attorney incompatible with the practice area fails closed');
    const memberUnmapped = await offered(base, { ...WEEK, attorneyId: 'doug-martinson', practiceAreaId: 'probate' });
    assert.equal(memberUnmapped.status, 503, 'group member without an attorney mapping fails closed (never silently round-robined)');
    const areaUnmapped = await offered(base, { ...WEEK, practiceAreaId: 'personal-injury' });
    assert.equal(areaUnmapped.status, 503, 'practice area without a routing-group mapping fails closed');
    assert.equal(provider.calls.length, 4, 'failed routing never reaches the provider');

    // Unknown or inactive catalog keys are request errors (400), never
    // routing inputs.
    assert.equal((await offered(base, { ...WEEK, attorneyId: 'made-up-attorney' })).status, 400);
    assert.equal((await offered(base, { ...WEEK, attorneyId: 'retired-attorney' })).status, 400);
    assert.equal((await offered(base, { ...WEEK, practiceAreaId: 'made-up-area' })).status, 400);
  });
});

test('offered-slots: the default path is UNAVAILABLE when eventTypeId is omitted — its presence is the tenant permission', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
  const configService = fixtureConfig({
    calcom: { attorneyEventTypes: { 'clay-martinson': 222 }, routingGroupEventTypes: { probate: 333 }, durationMinutes: 30 },
  });
  await withServer({ configService, availabilityProvider: provider }, async (base) => {
    const noContext = await offered(base, WEEK);
    assert.equal(noContext.status, 503);
    assert.equal((await noContext.json()).error.code, 'availability_not_configured');
    assert.equal(provider.calls.length, 0);
    // Mapped routes still work without a default.
    assert.equal((await offered(base, { ...WEEK, attorneyId: 'clay-martinson' })).status, 200);
    assert.equal((await offered(base, { ...WEEK, practiceAreaId: 'probate' })).status, 200);
  });
});

test('offered-slots: duration propagates — request wins, config default otherwise, and the hours check uses the FULL appointment', async () => {
  const lateSlot = '2026-09-01T21:45:00.000Z'; // 16:45 local
  const provider = mockProvider({ slots: [{ startsAt: lateSlot }] });
  const configService = fixtureConfig({ calcom: { eventTypeId: 111, durationMinutes: 15 } });
  await withServer({ configService, availabilityProvider: provider }, async (base) => {
    const fits = await (await offered(base, WEEK)).json();
    assert.equal(fits.status, 'offered');
    assert.equal(fits.slots[0].durationMinutes, 15, 'config default duration');

    const spills = await (await offered(base, { ...WEEK, durationMinutes: 60 })).json();
    assert.equal(spills.status, 'no-availability', 'request duration overrides and the whole appointment must fit');
  });
});

// ── Ranking reuse, the two-slot cap, and no pre-ranking truncation ──────────

test('offered-slots: the EXISTING ranking pipeline governs the offer — policy reorders, hours exclude, at most TWO slots return', async () => {
  const provider = mockProvider({
    slots: [{ startsAt: SEP_TUE_2PM }, { startsAt: SEP_TUE_8PM }, { startsAt: SEP_TUE_9AM }, { startsAt: SEP_WED_10AM }],
  });
  const configService = fixtureConfig({ policy: { preferredTimeOfDay: 'morning' } });
  await withServer({ configService, availabilityProvider: provider }, async (base) => {
    const first = await (await offered(base, WEEK)).json();
    assert.equal(first.status, 'offered');
    assert.deepEqual(first.slots.map((s) => s.startsAt), [SEP_TUE_9AM, SEP_WED_10AM],
      'the two morning slots outrank; the model receives EXACTLY what it presents');
    assert.equal(first.slots.length, MAX_OFFERED_TO_AGENT);
    assert.ok(first.slots.every((s) => !('score' in s) && !('matchedDimensions' in s)),
      'internal ranking data never reaches the model');
    assert.deepEqual(first.window, WEEK);

    const second = await (await offered(base, WEEK)).json();
    // Deterministic EXCEPT the booking context: each availability check
    // issues a fresh single-use opaque value.
    const { bookingContext: bc1, ...firstRest } = first;
    const { bookingContext: bc2, ...secondRest } = second;
    assert.deepEqual(secondRest, firstRest, 'identical configuration + availability -> identical offer');
    assert.match(bc1, /^bct_[A-Za-z0-9_-]{40,}$/, 'an offered response carries the opaque booking context');
    assert.notEqual(bc2, bc1, 'each check issues a fresh single-use context');
  });
});

/** Weekday-only synthetic business-hour slots from 2026-09-01 onward. */
function weekdaySlots(count) {
  const slots = [];
  for (let day = 0; slots.length < count; day += 1) {
    const ms = Date.parse('2026-09-01T00:00:00Z') + day * 86_400_000;
    const weekday = new Date(ms).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const date = new Date(ms).toISOString().slice(0, 10);
    for (let half = 0; half < 16 && slots.length < count; half += 1) {
      const hour = 9 + Math.floor(half / 2) + 5; // local 09:00-16:30 -> UTC (CDT)
      const minute = half % 2 === 0 ? '00' : '30';
      slots.push({ startsAt: `${date}T${String(hour).padStart(2, '0')}:${minute}:00.000Z` });
    }
  }
  return slots;
}

test('offered-slots: NO pre-ranking truncation — a policy-preferred slot deep in a large set still ranks first', async () => {
  // 300 valid weekday slots; ONLY the very last one belongs to the
  // caller's requested attorney. Under the previous 200-slot
  // chronological pre-truncation, slot #300 would have been discarded
  // before ranking ever saw it. The whole set must rank, and the deep
  // slot must win.
  const { selectOfferedSlots } = require('./selection');
  const cs = fixtureConfig();
  const many = weekdaySlots(300).map((s) => ({ ...s, durationMinutes: 30 }));
  many[299] = { ...many[299], attorneyId: 'clay-martinson' };
  const ranked = selectOfferedSlots({
    configService: cs, organizationKey: FIRM, slots: many,
    request: { attorneyId: 'clay-martinson' }, maxSlots: 3000, limit: 2,
  });
  assert.equal(ranked.slots[0].attorneyId, 'clay-martinson',
    'slot #300 wins on the caller\'s ask — chronological pre-truncation would have discarded it');
  assert.equal(ranked.slots[0].startsAt, many[299].startsAt);

  // And over HTTP: a 300+ slot provider response passes through the
  // consolidated route without any batch-cap error.
  const provider = mockProvider({ slots: weekdaySlots(320) });
  await withServer({ configService: fixtureConfig(), availabilityProvider: provider }, async (base) => {
    const res = await offered(base, { dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'offered');
    assert.equal(body.slots.length, MAX_OFFERED_TO_AGENT);
  });
});

test('offered-slots: empty availability is an honest no-availability — and hours can honestly empty a real set', async () => {
  const empty = mockProvider({ slots: [] });
  await withServer({ configService: fixtureConfig(), availabilityProvider: empty }, async (base) => {
    const res = await (await offered(base, WEEK)).json();
    assert.equal(res.status, 'no-availability');
    assert.deepEqual(res.slots, []);
  });
  const allOutside = mockProvider({ slots: [{ startsAt: SEP_TUE_8PM }] });
  await withServer({ configService: fixtureConfig(), availabilityProvider: allOutside }, async (base) => {
    const res = await (await offered(base, WEEK)).json();
    assert.equal(res.status, 'no-availability');
  });
});

// ── Failure policy: everything fails closed ─────────────────────────────────

test('offered-slots: provider timeout / network / HTTP failures / malformed responses escalate — no times, ever', async () => {
  const cases = [
    [new AvailabilityTimeoutError(1200), 504, 'availability_timeout'],
    [new AvailabilityProviderError(500), 502, 'availability_provider_error'],
    [new AvailabilityProviderError(503), 502, 'availability_provider_error'],
    [new AvailabilityProviderError(0), 502, 'availability_provider_error'],   // network failure
    [new AvailabilityProviderError(401), 502, 'availability_provider_error'], // provider rejected our config
    [new AvailabilityProviderError(200), 502, 'availability_provider_error'], // error envelope behind HTTP 200
    [new AvailabilityMalformedError(), 502, 'availability_malformed'],
    [new AvailabilityNotConfiguredError(), 503, 'availability_not_configured'],
  ];
  for (const [error, httpStatus, code] of cases) {
    const { lines, telemetry } = captureTelemetry();
    await withServer({ configService: fixtureConfig(), availabilityProvider: mockProvider(error), telemetry }, async (base) => {
      const res = await offered(base, { ...WEEK, sessionId: 'session-fail' }, auth);
      assert.equal(res.status, httpStatus, code);
      const body = await res.json();
      assert.equal(body.error.code, code);
      assert.ok(body.error.correlationId);
      assert.ok(!('slots' in body), 'a failed check NEVER carries appointment times');
      assert.equal(lines.find((l) => l.event === 'guideherd.scheduling.availability_failed').code, code);
    });
  }
});

test('offered-slots: an UNKNOWN processing error fails closed to 500 — no catch-all ever produces raw slots', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }, { startsAt: SEP_TUE_2PM }] });
  const configService = fixtureConfig();
  const broken = Object.create(configService);
  broken.locations = { ...configService.locations, list: () => { throw new TypeError('store exploded'); } };
  await withServer({ configService: broken, availabilityProvider: provider }, async (base) => {
    const res = await offered(base, WEEK);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'internal_error');
    assert.ok(!('slots' in body) && !JSON.stringify(body).includes(SEP_TUE_9AM),
      'unknown failures NEVER degrade into spoken appointment times');
  });
});

// ── Telemetry and diagnostic bypass detection ───────────────────────────────

test('offered-slots: every check emits component timing telemetry — config, provider, ranking, total', async () => {
  const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }], timings: { headersMs: 3, bodyMs: 1 } });
  const { lines, telemetry } = captureTelemetry();
  await withServer({ configService: fixtureConfig(), availabilityProvider: provider, telemetry }, async (base) => {
    await offered(base, { ...WEEK, sessionId: 'session-timing' });
    const event = lines.find((l) => l.event === 'guideherd.scheduling.slots_offered');
    assert.equal(event.status, 'offered');
    assert.equal(event.receivedCount, 1);
    assert.equal(event.inWindowCount, 1);
    assert.equal(event.offeredCount, 1);
    assert.equal(event.sessionId, 'session-timing');
    for (const field of ['configMs', 'providerMs', 'rankMs', 'totalMs', 'providerHeadersMs', 'providerBodyMs']) {
      assert.equal(typeof event[field], 'number', `${field} is measured`);
    }
    assert.ok(!JSON.stringify(lines).includes(SEP_TUE_9AM), 'no slot content in telemetry');
  });
});

test('offered-slots: bypass detection is diagnostic and bounded — recorded on success, not on failure, pruned when stale', async () => {
  const handoff = {
    firmId: FIRM,
    caller: { fullName: 'Synthetic Caller', email: 'synthetic@example.com', phone: '+12565550100' },
    scheduling: { attorneyId: 'clay-martinson', practiceAreaId: 'personal-injury', consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
  const booked = (sessionId) => ({
    sessionId, status: 'booked',
    appointment: { startsAt: SEP_TUE_9AM, timezone: CHI }, reason: 'Initial consultation booked.',
  });

  // Recorded after success; pruning removes stale entries; a governed
  // booking raises nothing.
  {
    const { lines, telemetry } = captureTelemetry();
    const provider = mockProvider({ slots: [{ startsAt: SEP_TUE_9AM }] });
    await withServer({ configService: fixtureConfig(), availabilityProvider: provider, telemetry }, async (base, app) => {
      app.diagnostics.offeredSlotsSessions.set('stale-session', T0 - 2 * 60 * 60 * 1000);
      const created = await (await post(base, '/api/v1/handoffs', handoff)).json();
      await post(base, '/api/v1/demo/connect', { request: 'connect' }, auth);
      await offered(base, { ...WEEK, sessionId: created.sessionId });
      assert.ok(app.diagnostics.offeredSlotsSessions.has(created.sessionId), 'session recorded after a successful offer');
      assert.ok(!app.diagnostics.offeredSlotsSessions.has('stale-session'), 'stale entries prune lazily');
      await post(base, '/api/v1/demo/outcome', booked(created.sessionId), auth);
      assert.ok(!lines.some((l) => l.event === 'guideherd.scheduling.policy_bypass_suspected'),
        'a policy-governed booking raises nothing');
    });
  }

  // NOT recorded after a failed check; a booked outcome then warns.
  {
    const { lines, telemetry } = captureTelemetry();
    const provider = mockProvider(new AvailabilityTimeoutError(1200));
    await withServer({ configService: fixtureConfig(), availabilityProvider: provider, telemetry }, async (base, app) => {
      const created = await (await post(base, '/api/v1/handoffs', handoff)).json();
      await post(base, '/api/v1/demo/connect', { request: 'connect' }, auth);
      await offered(base, { ...WEEK, sessionId: created.sessionId });
      assert.equal(app.diagnostics.offeredSlotsSessions.size, 0, 'failures record nothing');
      await post(base, '/api/v1/demo/outcome', booked(created.sessionId), auth);
      const bypass = lines.find((l) => l.event === 'guideherd.scheduling.policy_bypass_suspected');
      assert.ok(bypass, 'a booked outcome without a policy-governed offer is LOUD');
      assert.equal(bypass.sessionId, created.sessionId);
    });
  }
  // DIAGNOSTIC LIMITATION (documented, deliberate): the map is process
  // memory — a restart empties it, so a booking spanning a restart can
  // warn falsely. Single-replica deployment; detector, not enforcement.
});

// ── Volume and local processing time ────────────────────────────────────────

function syntheticSlots(count) {
  const slots = [];
  for (let i = 0; slots.length < count; i += 1) {
    const day = new Date(Date.parse('2026-09-01T00:00:00Z') + Math.floor(i / 16) * 86_400_000).toISOString().slice(0, 10);
    const half = i % 16;
    const hour = 9 + Math.floor(half / 2) + 5;
    const minute = half % 2 === 0 ? '00' : '30';
    slots.push({ startsAt: `${day}T${String(hour).padStart(2, '0')}:${minute}:00.000Z` });
  }
  return slots;
}

test('offered-slots: representative volumes process locally in milliseconds — latency does not scale through token generation', async () => {
  const volumes = [
    ['one day', syntheticSlots(16), { dateFrom: '2026-09-01', dateTo: '2026-09-01' }],
    ['one business week', syntheticSlots(80), { dateFrom: '2026-09-01', dateTo: '2026-09-07' }],
    ['large valid set', syntheticSlots(480), { dateFrom: '2026-09-01', dateTo: '2026-09-30' }],
  ];
  for (const [label, slots, window] of volumes) {
    const { telemetry } = captureTelemetry();
    await withServer({
      configService: fixtureConfig({ policy: { preferredTimeOfDay: 'morning' } }),
      availabilityProvider: mockProvider({ slots }),
      telemetry,
    }, async (base) => {
      await offered(base, window); // warm-up: Intl/timezone compilation is not the measurement
      const started = performance.now();
      const res = await offered(base, window);
      const elapsed = performance.now() - started;
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(['offered', 'no-availability'].includes(body.status));
      assert.ok(body.slots.length <= MAX_OFFERED_TO_AGENT, 'the model never receives more than two slots');
      // Local mocked-provider bound only — NOT a claim about Cal.com's
      // real network latency, which the voice test must measure.
      assert.ok(elapsed < 500, `${label}: local processing took ${elapsed.toFixed(0)}ms`);
      console.log(`  offered-slots local timing — ${label}: ${slots.length} slots in ${elapsed.toFixed(1)}ms (route+engine, mocked provider)`);
    });
  }
});

// ── The Cal.com client itself ───────────────────────────────────────────────

test('calcom client: ONE bounded request with exact UTC instants, auth header, and API version — no retries', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ status: 'success', data: { '2026-09-01': [{ start: SEP_TUE_9AM }] } }) };
  };
  const provider = createCalcomAvailabilityProvider({ apiKey: 'test-key-never-real', fetchImpl });
  const { slots, timings } = await provider.fetchAvailability({
    eventTypeId: 111,
    startUtcMs: Date.parse('2026-09-01T05:00:00Z'),
    endUtcMs: Date.parse('2026-09-08T05:00:00Z'),
  });
  assert.deepEqual(slots, [{ startsAt: SEP_TUE_9AM }]);
  assert.equal(typeof timings.headersMs, 'number');
  assert.equal(typeof timings.bodyMs, 'number');
  assert.equal(seen.length, 1, 'exactly one request, no retry');
  const { url, options } = seen[0];
  assert.ok(url.includes('eventTypeId=111'));
  // cal-api-version 2024-09-04 uses `start`/`end`; the legacy
  // startTime/endTime names are rejected by the live API (HTTP 400).
  assert.ok(url.includes(`start=${encodeURIComponent('2026-09-01T05:00:00.000Z')}`));
  assert.ok(url.includes(`end=${encodeURIComponent('2026-09-08T05:00:00.000Z')}`));
  assert.ok(!url.includes('startTime='), 'legacy range parameter names must not be sent');
  assert.equal(options.headers['cal-api-version'], '2024-09-04');
  assert.ok(options.headers.authorization.startsWith('Bearer '));
  assert.ok(options.signal, 'every request carries an abort signal');
});

test('calcom client: hard clamped timeout; typed failures; parsing fails closed on every ambiguous shape', async () => {
  // The configured timeout is clamped to the interactive range.
  assert.equal(clampTimeoutMs(undefined), 1200);
  assert.equal(clampTimeoutMs('900'), 900);
  assert.equal(clampTimeoutMs(10_000), MAX_TIMEOUT_MS, 'a configured timeout can never exceed the voice budget');
  assert.equal(clampTimeoutMs(-5), 1200);

  // A hung provider is aborted by the client's own timer.
  const hung = createCalcomAvailabilityProvider({
    apiKey: 'k', timeoutMs: 120,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  const started = performance.now();
  await assert.rejects(() => hung.fetchAvailability({ eventTypeId: 1, startUtcMs: 0, endUtcMs: 1 }),
    (err) => err instanceof AvailabilityTimeoutError);
  assert.ok(performance.now() - started < 800, 'the timeout fires on the configured budget, not a socket default');

  // HTTP and network failures are typed.
  const http500 = createCalcomAvailabilityProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await assert.rejects(() => http500.fetchAvailability({ eventTypeId: 1, startUtcMs: 0, endUtcMs: 1 }),
    (err) => err instanceof AvailabilityProviderError && err.httpStatus === 500);
  const network = createCalcomAvailabilityProvider({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => network.fetchAvailability({ eventTypeId: 1, startUtcMs: 0, endUtcMs: 1 }),
    (err) => err instanceof AvailabilityProviderError && err.httpStatus === 0);
  const nonJson = createCalcomAvailabilityProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }) });
  await assert.rejects(() => nonJson.fetchAvailability({ eventTypeId: 1, startUtcMs: 0, endUtcMs: 1 }),
    (err) => err instanceof AvailabilityMalformedError);
  const unconfigured = createCalcomAvailabilityProvider({ fetchImpl: async () => { throw new Error('never called'); } });
  await assert.rejects(() => unconfigured.fetchAvailability({ eventTypeId: 1, startUtcMs: 0, endUtcMs: 1 }),
    (err) => err instanceof AvailabilityNotConfiguredError);

  // Parsing: documented fixtures parse; everything ambiguous fails closed.
  // v2 contract shape (cal-api-version 2024-09-04) with duplicates: deduplicated deterministically.
  assert.deepEqual(
    parseCalcomSlots({ status: 'success', data: { '2026-09-01': [{ start: SEP_TUE_2PM }, { start: SEP_TUE_9AM }, { start: SEP_TUE_9AM }] } }),
    [{ startsAt: SEP_TUE_9AM }, { startsAt: SEP_TUE_2PM }], 'v2 shape parses; duplicates collapse; chronological order');
  // v1 legacy shape.
  assert.deepEqual(parseCalcomSlots({ slots: { '2026-09-01': [{ time: SEP_TUE_9AM }] } }), [{ startsAt: SEP_TUE_9AM }]);
  // Provider error envelope behind HTTP 200 -> provider error, never empty availability.
  assert.throws(() => parseCalcomSlots({ status: 'error', error: { message: 'nope' } }),
    (err) => err instanceof AvailabilityProviderError && err.httpStatus === 200);
  // Unknown / malformed shapes fail closed.
  assert.throws(() => parseCalcomSlots({ unexpected: true }), AvailabilityMalformedError);
  assert.throws(() => parseCalcomSlots({ data: { '2026-09-01': [{ start: 'not-a-date' }] } }), AvailabilityMalformedError);
  assert.throws(() => parseCalcomSlots({ data: { '2026-09-01': [{ begin: SEP_TUE_9AM }] } }), AvailabilityMalformedError);
  assert.throws(() => parseCalcomSlots({ data: { '2026-09-01': 'not-an-array' } }), AvailabilityMalformedError);
  assert.throws(() => parseCalcomSlots([]), AvailabilityMalformedError);
  // Oversized responses are rejected, not truncated.
  const oversized = { data: { '2026-09-01': Array.from({ length: 3001 }, (_, i) => ({ start: new Date(i * 60000).toISOString() })) } };
  assert.throws(() => parseCalcomSlots(oversized), /more than 3000 slots/);
});
