'use strict';

/**
 * Live slot selection tests (ADR-0012 / GitLab #66): the business-hours
 * HARD constraint (hours.js), the composed selection module, and — the
 * acceptance criterion — the INTEGRATION SEAM over HTTP: a saved policy
 * observably reorders offered slots, and an appointment outside
 * configured business hours is never offered. Deterministic throughout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createTelemetry } = require('../telemetry/telemetry');
const { applyBusinessHoursConstraint, fitsBusinessHours } = require('./hours');
const { selectOfferedSlots, MAX_SLOTS } = require('./selection');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

// Huntsville is America/Chicago (UTC-5 in July). 2026-07-13 is a Monday.
const CHI = 'America/Chicago';
const slot = (startsAt, extra = {}) => ({ startsAt, durationMinutes: 30, ...extra });
const MON_9AM = '2026-07-13T14:00:00Z';   // 09:00 Monday local
const MON_10AM = '2026-07-13T15:00:00Z';  // 10:00 Monday local
const MON_2PM = '2026-07-13T19:00:00Z';   // 14:00 Monday local
const MON_8PM = '2026-07-14T01:00:00Z';   // 20:00 Monday local — outside hours
const SUN_10AM = '2026-07-12T15:00:00Z';  // Sunday local — closed day

const HOURS_MON_TO_FRI_9_5 = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opens: '09:00', closes: '17:00' }));

// ── hours.js ────────────────────────────────────────────────────────────────

test('hours: a slot fits only when the WHOLE appointment sits inside one window on one local day', () => {
  const windows = HOURS_MON_TO_FRI_9_5;
  assert.ok(fitsBusinessHours(slot(MON_9AM), windows, CHI), '09:00-09:30 Monday fits');
  assert.ok(fitsBusinessHours({ startsAt: '2026-07-13T21:30:00Z', durationMinutes: 30 }, windows, CHI),
    '16:30-17:00 fits — ending exactly at close is allowed');
  assert.equal(fitsBusinessHours({ startsAt: '2026-07-13T21:45:00Z', durationMinutes: 30 }, windows, CHI), false,
    '16:45-17:15 spills past close');
  assert.equal(fitsBusinessHours(slot(MON_8PM), windows, CHI), false, 'evening excluded');
  assert.equal(fitsBusinessHours(slot(SUN_10AM), windows, CHI), false, 'closed day excluded');
  assert.equal(fitsBusinessHours({ startsAt: '2026-07-14T04:45:00Z', durationMinutes: 30 }, windows, CHI), false,
    '23:45 Monday crossing midnight excluded');
  assert.equal(fitsBusinessHours(slot(MON_9AM), windows, 'Not/AZone'), false, 'unknown timezone fails closed');
});

test('hours: constraint scoping — named location wins; sole location covers unlabeled; several locations cannot guess', () => {
  const main = { key: 'main', timezone: CHI, officeHours: HOURS_MON_TO_FRI_9_5 };
  const east = { key: 'east', timezone: 'America/New_York', officeHours: [{ dayOfWeek: 1, opens: '12:00', closes: '18:00' }] };

  // Inert with no hours anywhere.
  const inert = applyBusinessHoursConstraint({ slots: [slot(MON_8PM)], locations: [{ key: 'x', officeHours: [] }], orgTimezone: CHI });
  assert.equal(inert.status, 'none');
  assert.equal(inert.slots.length, 1);

  // Sole hours-bearing location judges unlabeled slots.
  const sole = applyBusinessHoursConstraint({ slots: [slot(MON_9AM), slot(MON_8PM)], locations: [main], orgTimezone: CHI });
  assert.deepEqual(sole.slots.map((s) => s.startsAt), [MON_9AM]);
  assert.equal(sole.removed, 1);

  // A slot naming a location is judged by THAT location's hours/timezone:
  // 10:00 Chicago = 11:00 New York — before east's noon opening.
  const named = applyBusinessHoursConstraint({
    slots: [slot(MON_10AM, { location: 'east' }), slot(MON_2PM, { location: 'east' })],
    locations: [main, east], orgTimezone: CHI,
  });
  assert.deepEqual(named.slots.map((s) => s.startsAt), [MON_2PM], 'east judges in America/New_York');

  // Several hours-bearing locations + unlabeled slot: unscoped, passes visibly.
  const ambiguous = applyBusinessHoursConstraint({ slots: [slot(MON_8PM)], locations: [main, east], orgTimezone: CHI });
  assert.equal(ambiguous.slots.length, 1);
  assert.equal(ambiguous.unscoped, 1);
});

// ── selection module ────────────────────────────────────────────────────────

function fixtureConfig({ policy, hours = HOURS_MON_TO_FRI_9_5 } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: CHI });
  configService.locations.create(FIRM, { key: 'huntsville', name: 'Huntsville Office', timezone: CHI, officeHours: hours });
  if (policy) configService.settings.set(FIRM, 'scheduling', 'policy', policy);
  return configService;
}

test('selection: no policy → chronological offers, hours still constrain; determinism holds', () => {
  const configService = fixtureConfig();
  const input = [slot(MON_2PM), slot(MON_8PM), slot(MON_9AM)];
  const first = selectOfferedSlots({ configService, organizationKey: FIRM, slots: input });
  assert.deepEqual(first.slots.map((s) => s.startsAt), [MON_9AM, MON_2PM], 'chronological; evening never offered');
  assert.equal(first.applied.policy, false);
  assert.equal(first.applied.businessHours, 'applied');
  assert.equal(first.applied.removedOutsideHours, 1);

  const second = selectOfferedSlots({ configService, organizationKey: FIRM, slots: [...input] });
  assert.deepEqual(second.slots, first.slots, 'same availability + same policy → same offer');
});

test('selection: "mornings preferred" observably reorders; the firm-wide policy shapes the offer', () => {
  const configService = fixtureConfig({ policy: { preferredTimeOfDay: 'morning' } });
  const result = selectOfferedSlots({
    configService, organizationKey: FIRM, slots: [slot(MON_2PM), slot(MON_9AM), slot(MON_10AM)],
  });
  assert.deepEqual(result.slots.map((s) => s.startsAt), [MON_9AM, MON_10AM, MON_2PM],
    'mornings outrank the afternoon regardless of arrival order');
  assert.equal(result.applied.policy, true);
  assert.ok(result.applied.dimensions.includes('preferred-time-of-day'));
});

test('selection: the firm\'s own hours excluding EVERYTHING is an honest empty offer — loudly', () => {
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
  const configService = fixtureConfig();
  const result = selectOfferedSlots({
    configService, organizationKey: FIRM, slots: [slot(MON_8PM), slot(SUN_10AM)], telemetry,
  });
  assert.deepEqual(result.slots, []);
  assert.equal(result.applied.removedOutsideHours, 2);
  const exhausted = lines.find((l) => l.event === 'guideherd.scheduling.slots_exhausted');
  assert.equal(exhausted.severity ?? 'warn', 'warn');
  assert.equal(exhausted.removedCount, 2);
  const selected = lines.find((l) => l.event === 'guideherd.scheduling.slots_selected');
  assert.equal(selected.offeredCount, 0);
  assert.equal(JSON.stringify(lines).includes(MON_8PM), false, 'no slot content in telemetry');
});

test('selection: bounded, validated input — non-arrays and oversized batches fail loudly', () => {
  const configService = fixtureConfig();
  assert.throws(() => selectOfferedSlots({ configService, organizationKey: FIRM, slots: 'nope' }), (e) => e.status === 400);
  const flood = Array.from({ length: MAX_SLOTS + 1 }, () => slot(MON_9AM));
  assert.throws(() => selectOfferedSlots({ configService, organizationKey: FIRM, slots: flood }), (e) => e.status === 400);
  assert.throws(() => selectOfferedSlots({ configService, organizationKey: 'no-such-org', slots: [] }), (e) => e.status === 404);
});

// ── The integration seam over HTTP (acceptance criterion) ──────────────────

async function withServer(configService, fn) {
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: false, async sendSummary() { return { status: 'not-configured' }; } },
    configService,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('HTTP: the saved policy reorders REAL offered slots at the seam; outside-hours is never offered; auth is enforced', async () => {
  const configService = fixtureConfig({ policy: { preferredTimeOfDay: 'morning', preferredAttorneys: ['clay-martinson'] } });
  await withServer(configService, async (base) => {
    // Unauthenticated and wrong-secret callers are rejected.
    assert.equal((await post(base, '/api/v1/scheduling/slot-selection', { slots: [] })).status, 401);
    assert.equal((await post(base, '/api/v1/scheduling/slot-selection', { slots: [] },
      { authorization: 'Bearer wrong-secret' })).status, 403);

    const auth = { authorization: `Bearer ${SECRET}` };
    const res = await post(base, '/api/v1/scheduling/slot-selection', {
      slots: [
        slot(MON_2PM, { attorneyId: 'raina-baugher' }),
        slot(MON_8PM, { attorneyId: 'clay-martinson' }), // preferred attorney, but OUTSIDE HOURS
        slot(MON_10AM, { attorneyId: 'raina-baugher' }),
        slot(MON_9AM, { attorneyId: 'clay-martinson' }),
      ],
      sessionId: 'mock-session-1',
    }, auth);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(body.slots.map((s) => [s.startsAt, s.attorneyId]), [
      [MON_9AM, 'clay-martinson'],   // morning + preferred attorney
      [MON_10AM, 'raina-baugher'],   // morning
      [MON_2PM, 'raina-baugher'],    // afternoon
    ], 'policy observably reorders the real offer');
    assert.equal(body.slots.some((s) => s.startsAt === MON_8PM), false,
      'an appointment outside business hours is NOT offered — even for the preferred attorney');
    assert.equal(body.applied.policy, true);
    assert.equal(body.applied.businessHours, 'applied');
    assert.equal(body.applied.removedOutsideHours, 1);

    // Malformed input over HTTP fails loudly, not silently.
    assert.equal((await post(base, '/api/v1/scheduling/slot-selection', { slots: 'nope' }, auth)).status, 400);
  });
});
