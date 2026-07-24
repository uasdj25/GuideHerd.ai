'use strict';

/**
 * The Scheduling Target Domain (GitLab #76): provider-neutral calendar
 * targets, the native route resolver, and its parity with the deployed
 * event-type resolver — same precedence, same fail-closed reasons, same
 * routeKind values.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSchedulingTargetsConfig,
  resolveSchedulingTarget,
  resolveAppointmentDuration,
} = require('./scheduling-targets');
const { resolveBookingRoute, RoutingUnresolvedError, AvailabilityError } = require('./availability');

/** The Martinson & Beason shape, expressed provider-neutrally. */
const CONFIG = normalizeSchedulingTargetsConfig({
  provider: 'reference',
  defaultCalendar: 'cal-default',
  attorneyCalendars: { 'clay-martinson': 'cal-clay', 'doug-martinson': 'cal-doug' },
  routingGroupCalendars: { probate: 'cal-probate-shared' },
  appointmentDurations: { 'initial-consultation': 30, 'extended-consultation': 60 },
  defaultDurationMinutes: 30,
}).value;

const GROUPS = [
  { key: 'probate', serviceArea: 'probate', providers: ['clay-martinson', 'doug-martinson'], active: true },
  { key: 'family', serviceArea: 'family-law', providers: ['clay-martinson', 'raina-baugher'], active: true },
];

// ── Normalization ───────────────────────────────────────────────────────────

test('targets: dark by default — no document means provider null and nothing bound', () => {
  const { value, issues } = normalizeSchedulingTargetsConfig(null);
  assert.deepEqual(value, {
    provider: null, defaultCalendar: null, attorneyCalendars: {},
    routingGroupCalendars: {}, appointmentDurations: {}, defaultDurationMinutes: 30,
    schedulableAttorneys: [], requireFullCoverage: false,
  });
  assert.deepEqual(issues, []);
});

test('targets: normalization is strict for the producer — every malformed field is an issue', () => {
  const { value, issues } = normalizeSchedulingTargetsConfig({
    provider: '',
    defaultCalendar: '   ',
    attorneyCalendars: { 'clay-martinson': 42, '': 'cal-x' },
    routingGroupCalendars: 'nope',
    appointmentDurations: { 'initial-consultation': 0 },
    defaultDurationMinutes: 481,
    surprise: true,
  });
  assert.deepEqual(value.attorneyCalendars, {});
  assert.deepEqual(value.routingGroupCalendars, {});
  assert.equal(value.defaultDurationMinutes, 30);
  for (const fragment of ['unknown field: surprise', 'provider must be', 'defaultCalendar must be',
    'attorneyCalendars.clay-martinson', 'routingGroupCalendars must map',
    'appointmentDurations.initial-consultation', 'defaultDurationMinutes must be']) {
    assert.ok(issues.some((i) => i.includes(fragment)), `expected issue containing "${fragment}"`);
  }
});

test('targets: appointment types own duration; the default covers the rest', () => {
  assert.equal(resolveAppointmentDuration(CONFIG, 'extended-consultation'), 60);
  assert.equal(resolveAppointmentDuration(CONFIG, 'initial-consultation'), 30);
  assert.equal(resolveAppointmentDuration(CONFIG, 'unknown-type'), 30);
  assert.equal(resolveAppointmentDuration(CONFIG, null), 30);
});

// ── Native route resolution: precedence and fail-closed matrix ──────────────

test('targets: attorney routes resolve that attorney\'s calendar binding', () => {
  const route = resolveSchedulingTarget({ config: CONFIG, attorneyId: 'clay-martinson', routingGroups: GROUPS });
  assert.deepEqual(route, {
    routeKind: 'attorney', attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    targets: [{ attorneyId: 'clay-martinson', calendarRef: 'cal-clay' }],
  });
});

test('targets: attorney + compatible area is honored and records the area', () => {
  const route = resolveSchedulingTarget({
    config: CONFIG, attorneyId: 'doug-martinson', practiceAreaId: 'probate', routingGroups: GROUPS,
  });
  assert.equal(route.routeKind, 'attorney');
  assert.equal(route.practiceAreaId, 'probate');
  assert.deepEqual(route.targets, [{ attorneyId: 'doug-martinson', calendarRef: 'cal-doug' }]);
});

test('targets: a group\'s provider-side calendar serves the area, unattributed', () => {
  const route = resolveSchedulingTarget({ config: CONFIG, practiceAreaId: 'probate', routingGroups: GROUPS });
  assert.deepEqual(route, {
    routeKind: 'routing-group', attorneyId: null, routingGroupKey: 'probate', practiceAreaId: 'probate',
    targets: [{ attorneyId: null, calendarRef: 'cal-probate-shared' }],
  });
});

test('targets: without a group calendar, a FULLY bound member pool serves the area, attributed', () => {
  const config = {
    ...CONFIG,
    routingGroupCalendars: {},
    attorneyCalendars: { ...CONFIG.attorneyCalendars },
  };
  const route = resolveSchedulingTarget({ config, practiceAreaId: 'probate', routingGroups: GROUPS });
  assert.equal(route.routeKind, 'routing-group');
  assert.deepEqual(route.targets, [
    { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
    { attorneyId: 'doug-martinson', calendarRef: 'cal-doug' },
  ]);
});

test('targets: a PARTIALLY bound pool fails closed — a group never silently shrinks', () => {
  // family-law: clay is bound, raina is not; no group calendar.
  assert.throws(
    () => resolveSchedulingTarget({ config: CONFIG, practiceAreaId: 'family-law', routingGroups: GROUPS }),
    (err) => err instanceof RoutingUnresolvedError && err.reason === 'routing_group_unmapped',
  );
});

test('targets: the deployed fail-closed matrix is preserved reason for reason', () => {
  const cases = [
    // Unbound attorney.
    [{ attorneyId: 'morris-lilienthal' }, 'attorney_unmapped'],
    // Bound attorney, area whose single group excludes them.
    [{ attorneyId: 'doug-martinson', practiceAreaId: 'family-law' }, 'attorney_not_permitted'],
    // Member of the area's group but UNBOUND: membership never
    // substitutes for a binding.
    [{ attorneyId: 'raina-baugher', practiceAreaId: 'family-law' }, 'attorney_unmapped'],
    // Area no group serves.
    [{ practiceAreaId: 'personal-injury' }, 'no_routing_group'],
  ];
  for (const [request, reason] of cases) {
    assert.throws(
      () => resolveSchedulingTarget({ config: CONFIG, ...request, routingGroups: GROUPS }),
      (err) => err instanceof RoutingUnresolvedError && err.reason === reason,
      `${JSON.stringify(request)} -> ${reason}`,
    );
  }
  // Two active groups for one area: ambiguous, fail closed.
  const ambiguous = [...GROUPS, { key: 'probate-2', serviceArea: 'probate', providers: ['doug-martinson'], active: true }];
  assert.throws(
    () => resolveSchedulingTarget({ config: CONFIG, practiceAreaId: 'probate', routingGroups: ambiguous }),
    (err) => err.reason === 'ambiguous_routing_group',
  );
});

test('targets: the default path requires the explicit defaultCalendar permission', () => {
  const route = resolveSchedulingTarget({ config: CONFIG, routingGroups: GROUPS });
  assert.equal(route.routeKind, 'default');
  assert.deepEqual(route.targets, [{ attorneyId: null, calendarRef: 'cal-default' }]);

  const withoutDefault = { ...CONFIG, defaultCalendar: null };
  assert.throws(
    () => resolveSchedulingTarget({ config: withoutDefault, routingGroups: GROUPS }),
    (err) => err instanceof AvailabilityError && err.code === 'availability_not_configured',
  );
});

// ── Parity with the deployed resolver ───────────────────────────────────────

test('targets: routing OUTCOMES are identical to the deployed event-type resolver across the matrix', () => {
  // The deployed Martinson & Beason configuration, in its own domain…
  const legacyConfig = {
    eventTypeId: 6287134,
    attorneyEventTypes: { 'clay-martinson': 6287134, 'doug-martinson': 6330128 },
    routingGroupEventTypes: { probate: 6330099 },
  };
  // …and the same tenant expressed provider-neutrally (CONFIG above).
  const requests = [
    { attorneyId: 'clay-martinson' },
    { attorneyId: 'doug-martinson' },
    { attorneyId: 'clay-martinson', practiceAreaId: 'probate' },
    { attorneyId: 'doug-martinson', practiceAreaId: 'probate' },
    { practiceAreaId: 'probate' },
    {},
    { attorneyId: 'morris-lilienthal' },
    { attorneyId: 'raina-baugher', practiceAreaId: 'probate' },
    { practiceAreaId: 'personal-injury' },
  ];
  for (const request of requests) {
    let legacy;
    try {
      const r = resolveBookingRoute({ config: legacyConfig, ...request, routingGroups: GROUPS });
      legacy = { ok: true, routeKind: r.routeKind, attorneyId: r.attorneyId, routingGroupKey: r.routingGroupKey };
    } catch (err) {
      legacy = { ok: false, code: err.code, reason: err.reason ?? null };
    }
    let native;
    try {
      const r = resolveSchedulingTarget({ config: CONFIG, ...request, routingGroups: GROUPS });
      native = { ok: true, routeKind: r.routeKind, attorneyId: r.attorneyId, routingGroupKey: r.routingGroupKey };
    } catch (err) {
      native = { ok: false, code: err.code, reason: err.reason ?? null };
    }
    assert.deepEqual(native, legacy, `outcome parity for ${JSON.stringify(request)}`);
  }
});

// ── Domain registration ─────────────────────────────────────────────────────

test('targets: the calendar-targets domain reads dark by default through the framework', () => {
  const { readDomain } = require('../configuration/framework');
  const { openDatabase } = require('../config/db');
  const { migrate } = require('../config/migrate');
  const { createConfigService } = require('../config/service');
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: 'org-a', name: 'A', timezone: 'UTC' });
  const { value } = readDomain(configService, 'calendar-targets', 'org-a');
  assert.equal(value.provider, null, 'native scheduling unconfigured until explicitly selected');
  assert.deepEqual(value.attorneyCalendars, {});
  db.close();
});
