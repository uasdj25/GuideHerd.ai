'use strict';

/**
 * Native slot generation (GitLab #78): business hours, buffers, notice,
 * horizon, granularity, holiday exceptions, DST correctness, hours
 * resolution, and the booking-window policy domain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateCandidateSlots,
  resolveHoursForTarget,
  normalizeBookingWindowConfig,
  zonedTimeToUtcMs,
} = require('./slot-generation');

const CHICAGO = 'America/Chicago';
// A plain CDT week: Tue 2026-09-01 .. Mon 2026-09-07.
const WEEK = {
  windowStartMs: Date.parse('2026-09-01T00:00:00Z'),
  windowEndMs: Date.parse('2026-09-08T00:00:00Z'),
};
const NOW = Date.parse('2026-08-01T12:00:00Z');
const WEEKDAY_9_TO_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opens: '09:00', closes: '17:00' }));

const gen = (overrides = {}) => generateCandidateSlots({
  windows: WEEKDAY_9_TO_5,
  timezone: CHICAGO,
  busyIntervals: [],
  durationMinutes: 30,
  nowMs: NOW,
  ...WEEK,
  ...overrides,
});

// ── Generation fundamentals ─────────────────────────────────────────────────

test('generation: slots live inside business hours in the firm timezone, on the granularity grid', () => {
  const slots = gen();
  assert.ok(slots.length > 0);
  // Tuesday 09:00 America/Chicago in September is 14:00 UTC (CDT).
  assert.equal(slots[0].startsAt, '2026-09-01T14:00:00.000Z');
  for (const slot of slots) {
    const ms = Date.parse(slot.startsAt);
    assert.equal((ms - Date.parse(slots[0].startsAt)) % (30 * 60_000) % (30 * 60_000), 0);
  }
  // The whole appointment fits: no slot starts at 17:00 or 16:31+ local.
  const last = slots[slots.length - 1];
  assert.equal(new Date(Date.parse(last.startsAt)).toISOString(), last.startsAt);
  // Weekend days (Sat 5th, Sun 6th local) produce nothing.
  assert.ok(!slots.some((s) => ['2026-09-05', '2026-09-06'].some((d) => s.startsAt.startsWith(d) && s.startsAt < `${d}T13`)),
    'no weekend availability');
});

test('generation: deterministic — identical inputs, identical output', () => {
  assert.deepEqual(gen(), gen());
});

test('generation: busy intervals subtract, including adjacency rules', () => {
  const busy = [{ startsAt: '2026-09-01T14:00:00.000Z', endsAt: '2026-09-01T15:00:00.000Z' }];
  const slots = gen({ busyIntervals: busy });
  assert.ok(!slots.some((s) => s.startsAt === '2026-09-01T14:00:00.000Z'), 'occupied start removed');
  assert.ok(!slots.some((s) => s.startsAt === '2026-09-01T14:30:00.000Z'), 'overlap removed');
  assert.ok(slots.some((s) => s.startsAt === '2026-09-01T15:00:00.000Z'), 'back-to-back after busy is allowed with zero buffers');
});

test('generation: buffers guard time around busy intervals, not the firm hours', () => {
  const busy = [{ startsAt: '2026-09-01T15:00:00.000Z', endsAt: '2026-09-01T16:00:00.000Z' }];
  const slots = gen({ busyIntervals: busy, policy: { bufferBeforeMinutes: 30, bufferAfterMinutes: 30 } });
  // 14:30 would end at 15:00 exactly; the 30-min after-buffer pushes into busy — removed.
  assert.ok(!slots.some((s) => s.startsAt === '2026-09-01T14:30:00.000Z'));
  // 16:00 starts as busy ends; the 30-min before-buffer overlaps — removed.
  assert.ok(!slots.some((s) => s.startsAt === '2026-09-01T16:00:00.000Z'));
  assert.ok(slots.some((s) => s.startsAt === '2026-09-01T16:30:00.000Z'));
  // First slot of the day is untouched: buffers never shrink business hours.
  assert.equal(slots[0].startsAt, '2026-09-01T14:00:00.000Z');
});

test('generation: minimum notice and horizon clamp the range', () => {
  // Now = Tue Sep 1, 13:00 UTC (08:00 CDT). 24h notice removes all of Tuesday.
  const now = Date.parse('2026-09-01T13:00:00Z');
  const noticed = gen({ nowMs: now, policy: { minimumNoticeMinutes: 24 * 60 } });
  assert.ok(noticed.length > 0);
  assert.ok(noticed.every((s) => Date.parse(s.startsAt) >= now + 24 * 60 * 60_000));
  // A 2-day horizon truncates the tail of the week.
  const horizoned = gen({ nowMs: now, policy: { horizonDays: 2 } });
  assert.ok(horizoned.every((s) => Date.parse(s.startsAt) + 30 * 60_000 <= now + 2 * 24 * 60 * 60_000));
});

test('generation: exception closures remove whole local days', () => {
  const slots = gen({ policy: { exceptions: [{ date: '2026-09-02' }] } });
  assert.ok(!slots.some((s) => {
    const ms = Date.parse(s.startsAt);
    return ms >= Date.parse('2026-09-02T05:00:00Z') && ms < Date.parse('2026-09-03T05:00:00Z');
  }), 'the closed local day offers nothing');
  assert.ok(slots.some((s) => s.startsAt.startsWith('2026-09-01')));
});

test('generation: appointments never straddle the closing time', () => {
  const slots = gen({ durationMinutes: 120 });
  // Latest 2h appointment inside 09:00–17:00 CDT starts 15:00 local = 20:00 UTC.
  const tuesday = slots.filter((s) => s.startsAt.startsWith('2026-09-01'));
  assert.equal(tuesday[tuesday.length - 1].startsAt, '2026-09-01T20:00:00.000Z');
});

test('generation: FAIL CLOSED — no hours means no slots, and busy data is mandatory', () => {
  assert.deepEqual(gen({ windows: [] }), []);
  assert.deepEqual(gen({ timezone: null }), []);
  assert.throws(() => gen({ busyIntervals: null }), TypeError);
});

// ── DST correctness ─────────────────────────────────────────────────────────

test('DST: wall-clock hours shift with the offset across spring forward', () => {
  // America/Chicago springs forward 2026-03-08 (CST -> CDT).
  const slots = generateCandidateSlots({
    windows: [{ dayOfWeek: 5, opens: '09:00', closes: '10:00' }, { dayOfWeek: 1, opens: '09:00', closes: '10:00' }],
    timezone: CHICAGO,
    busyIntervals: [],
    durationMinutes: 30,
    nowMs: Date.parse('2026-03-01T00:00:00Z'),
    windowStartMs: Date.parse('2026-03-06T00:00:00Z'), // Friday (CST)
    windowEndMs: Date.parse('2026-03-10T00:00:00Z'),   // Monday (CDT)
  });
  // Friday 09:00 CST = 15:00 UTC; Monday 09:00 CDT = 14:00 UTC.
  assert.deepEqual(slots.map((s) => s.startsAt), [
    '2026-03-06T15:00:00.000Z', '2026-03-06T15:30:00.000Z',
    '2026-03-09T14:00:00.000Z', '2026-03-09T14:30:00.000Z',
  ]);
});

test('DST: fall back neither skips nor duplicates a day', () => {
  // America/Chicago falls back 2026-11-01.
  const slots = generateCandidateSlots({
    windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opens: '09:00', closes: '09:30' })),
    timezone: CHICAGO,
    busyIntervals: [],
    durationMinutes: 30,
    nowMs: Date.parse('2026-10-25T00:00:00Z'),
    windowStartMs: Date.parse('2026-10-31T00:00:00Z'),
    windowEndMs: Date.parse('2026-11-03T00:00:00Z'),
  });
  // Exactly one 09:00 slot per local day: Sat (CDT 14:00Z), Sun (CST 15:00Z), Mon (CST 15:00Z).
  assert.deepEqual(slots.map((s) => s.startsAt), [
    '2026-10-31T14:00:00.000Z', '2026-11-01T15:00:00.000Z', '2026-11-02T15:00:00.000Z',
  ]);
});

test('DST: zonedTimeToUtcMs resolves plain and shifted wall times', () => {
  assert.equal(zonedTimeToUtcMs({ year: 2026, month: 9, day: 1, minutesOfDay: 9 * 60 }, CHICAGO),
    Date.parse('2026-09-01T14:00:00Z'));
  assert.equal(zonedTimeToUtcMs({ year: 2026, month: 1, day: 15, minutesOfDay: 9 * 60 }, CHICAGO),
    Date.parse('2026-01-15T15:00:00Z'));
});

// ── Hours resolution ────────────────────────────────────────────────────────

test('hours: attorney override first, sole hours-bearing location second, ambiguity fails closed', () => {
  const locations = [
    { key: 'main', timezone: CHICAGO, officeHours: WEEKDAY_9_TO_5 },
    { key: 'annex', timezone: CHICAGO, officeHours: [] },
  ];
  const override = { 'clay-martinson': [{ dayOfWeek: 2, opens: '10:00', closes: '12:00' }] };

  const viaOverride = resolveHoursForTarget({
    attorneyId: 'clay-martinson', attorneyHours: override, locations, orgTimezone: CHICAGO,
  });
  assert.equal(viaOverride.source, 'attorney-override');
  assert.deepEqual(viaOverride.windows, override['clay-martinson']);

  const viaLocation = resolveHoursForTarget({
    attorneyId: 'doug-martinson', attorneyHours: override, locations, orgTimezone: CHICAGO,
  });
  assert.equal(viaLocation.source, 'location');

  const none = resolveHoursForTarget({ locations: [], orgTimezone: CHICAGO });
  assert.deepEqual({ windows: none.windows, reason: none.reason }, { windows: [], reason: 'no_hours' });

  const ambiguous = resolveHoursForTarget({
    locations: [
      { key: 'a', officeHours: WEEKDAY_9_TO_5 },
      { key: 'b', officeHours: WEEKDAY_9_TO_5 },
    ],
    orgTimezone: CHICAGO,
  });
  assert.equal(ambiguous.reason, 'ambiguous_hours');
});

// ── Booking-window policy domain ────────────────────────────────────────────

test('booking-window: defaults are safe and hours-free — nothing here can open a calendar', () => {
  const { value, issues } = normalizeBookingWindowConfig(null);
  assert.deepEqual(value, {
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0,
    horizonDays: 60, slotGranularityMinutes: 30, cancellationCutoffMinutes: 0,
    rescheduleCutoffMinutes: 0, exceptions: [], attorneyHours: {},
  });
  assert.deepEqual(issues, []);
});

test('booking-window: strict producer issues for every malformed field', () => {
  const { issues } = normalizeBookingWindowConfig({
    bufferBeforeMinutes: -1,
    minimumNoticeMinutes: 'soon',
    horizonDays: 0,
    slotGranularityMinutes: 3,
    exceptions: [{ date: 'tomorrow' }],
    attorneyHours: { clay: [{ dayOfWeek: 9, opens: '9am', closes: '17:00' }] },
    surprise: 1,
  });
  for (const fragment of ['bufferBeforeMinutes', 'minimumNoticeMinutes', 'horizonDays',
    'slotGranularityMinutes', 'YYYY-MM-DD', 'attorneyHours.clay', 'unknown field: surprise']) {
    assert.ok(issues.some((i) => i.includes(fragment)), `expected issue containing "${fragment}"`);
  }
});
