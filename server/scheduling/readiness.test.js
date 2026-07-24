'use strict';

/**
 * Tenant scheduling readiness and the calendar-targets producer gate
 * (GitLab #77). Encodes the Martinson & Beason lesson as a permanent
 * regression: an enabled-but-unbound attorney can never be part of a
 * tenant that evaluates as ready.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { validateDomain, validateStoredDomainSettings } = require('../configuration/framework');
const { evaluateSchedulingReadiness } = require('./readiness');

const FIRM = 'firm-a';

function fixture({ targets } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Firm A', timezone: 'America/Chicago' });
  for (const key of ['clay-martinson', 'doug-martinson', 'morris-lilienthal']) {
    configService.providers.create(FIRM, { key, name: key, active: true });
  }
  configService.providers.create(FIRM, { key: 'retired-attorney', name: 'Retired', active: false });
  configService.serviceAreas.create(FIRM, { key: 'probate', name: 'Probate', active: true });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial', active: true });
  configService.routingGroups.create(FIRM, {
    key: 'probate', name: 'Probate', serviceArea: 'probate',
    providers: ['clay-martinson', 'doug-martinson'], active: true,
  });
  if (targets) configService.settings.set(FIRM, 'scheduling', 'calendar-targets', targets);
  return { db, configService };
}

const GOOD_TARGETS = {
  provider: 'reference',
  attorneyCalendars: { 'clay-martinson': 'cal-clay', 'doug-martinson': 'cal-doug' },
  routingGroupCalendars: { probate: 'cal-probate' },
  schedulableAttorneys: ['clay-martinson', 'doug-martinson'],
};

// ── Producer-gate cross-entity validation ───────────────────────────────────

test('calendar-targets gate: cross-entity strictness — real active entities, unambiguous groups, registered provider', () => {
  const { db, configService } = fixture();
  const context = { configService, organizationKey: FIRM, calendarProviderKeys: ['reference'] };
  assert.equal(validateDomain('calendar-targets', GOOD_TARGETS, context).ok, true);

  const issueOf = (doc) => validateDomain('calendar-targets', doc, context).issues.join(' | ');
  assert.match(issueOf({ ...GOOD_TARGETS, attorneyCalendars: { ghost: 'cal-x' } }), /unknown attorney/);
  assert.match(issueOf({ ...GOOD_TARGETS, attorneyCalendars: { 'retired-attorney': 'cal-x' } }), /not active/);
  assert.match(issueOf({ ...GOOD_TARGETS, schedulableAttorneys: ['ghost'] }), /schedulableAttorneys\.ghost: unknown attorney/);
  assert.match(issueOf({ ...GOOD_TARGETS, routingGroupCalendars: { ghost: 'cal-x' } }), /unknown routing group/);
  assert.match(issueOf({ ...GOOD_TARGETS, appointmentDurations: { ghost: 30 } }), /unknown consultation type/);
  assert.match(issueOf({ ...GOOD_TARGETS, provider: 'unregistered' }), /provider must be one of/);

  // Ambiguity: a second active group for the same area poisons the mapping.
  configService.routingGroups.create(FIRM, {
    key: 'probate-2', name: 'P2', serviceArea: 'probate', providers: ['doug-martinson'], active: true,
  });
  assert.match(issueOf(GOOD_TARGETS), /ambiguous/);
  db.close();
});

test('calendar-targets gate: the declared full-coverage rule makes enabled-but-unbound UNWRITABLE', () => {
  const { db, configService } = fixture();
  const context = { configService, organizationKey: FIRM };
  const gap = {
    ...GOOD_TARGETS,
    requireFullCoverage: true,
    schedulableAttorneys: ['clay-martinson', 'doug-martinson', 'morris-lilienthal'],
  };
  const { ok, issues } = validateDomain('calendar-targets', gap, context);
  assert.equal(ok, false);
  assert.match(issues.join(' | '), /morris-lilienthal.*full coverage.*no calendar binding/);
  // Binding Morris repairs it.
  const bound = { ...gap, attorneyCalendars: { ...gap.attorneyCalendars, 'morris-lilienthal': 'cal-morris' } };
  assert.equal(validateDomain('calendar-targets', bound, context).ok, true);
  db.close();
});

test('calendar-targets gate: the seed-import/boot gate refuses a stored invalid document', () => {
  const { db, configService } = fixture({
    targets: { ...GOOD_TARGETS, attorneyCalendars: { ghost: 'cal-x' } },
  });
  const problems = validateStoredDomainSettings(configService, FIRM);
  const targetProblem = problems.find((p) => p.domain === 'calendar-targets');
  assert.ok(targetProblem, 'the stored calendar-targets document is refused');
  assert.match(targetProblem.issues.join(' | '), /unknown attorney/);
  db.close();
});

// ── Tenant readiness ────────────────────────────────────────────────────────

test('readiness: the four states are distinct — exists, schedulable, bound, ready', () => {
  const { db, configService } = fixture({
    targets: {
      ...GOOD_TARGETS,
      // Morris exists and is ENABLED but has no binding.
      schedulableAttorneys: ['clay-martinson', 'doug-martinson', 'morris-lilienthal'],
    },
  });
  const readiness = evaluateSchedulingReadiness({ configService, organizationKey: FIRM });
  const byKey = Object.fromEntries(readiness.attorneys.map((a) => [a.key, a]));

  // exists + enabled + bound
  assert.deepEqual(
    { schedulable: byKey['clay-martinson'].schedulable, bound: byKey['clay-martinson'].bound },
    { schedulable: true, bound: true },
  );
  // exists + enabled + NOT bound — the M&B gap, individually visible.
  assert.deepEqual(
    { schedulable: byKey['morris-lilienthal'].schedulable, bound: byKey['morris-lilienthal'].bound },
    { schedulable: true, bound: false },
  );
  // exists only: in the catalog, not enabled, not bound.
  assert.equal(byKey['retired-attorney'].schedulable, false);
  assert.equal(byKey['retired-attorney'].bound, false);

  assert.deepEqual(readiness.enabledUnbound, ['morris-lilienthal']);
  assert.equal(readiness.ready, false, 'an enabled-but-unbound attorney can NEVER be presented as ready');
  assert.match(readiness.issues.join(' | '), /morris-lilienthal.*no calendar binding/);
  db.close();
});

test('readiness: a fully bound tenant with a selected provider is ready', () => {
  const { db, configService } = fixture({ targets: GOOD_TARGETS });
  const readiness = evaluateSchedulingReadiness({
    configService, organizationKey: FIRM, calendarProviderKeys: ['reference'],
  });
  assert.deepEqual(readiness.issues, []);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.routingGroups, [{
    key: 'probate', serviceArea: 'probate', active: true, covered: true, via: 'group-calendar',
  }]);
  db.close();
});

test('readiness: never vouches for what the producer gate would refuse', () => {
  const { db, configService } = fixture({
    targets: { ...GOOD_TARGETS, attorneyCalendars: { ...GOOD_TARGETS.attorneyCalendars, ghost: 'cal-x' } },
  });
  const readiness = evaluateSchedulingReadiness({ configService, organizationKey: FIRM });
  assert.equal(readiness.ready, false);
  assert.match(readiness.issues.join(' | '), /unknown attorney/);
  db.close();
});

test('readiness: unconfigured tenant is simply not ready — with reasons, not errors', () => {
  const { db, configService } = fixture();
  const readiness = evaluateSchedulingReadiness({ configService, organizationKey: FIRM });
  assert.equal(readiness.ready, false);
  assert.match(readiness.issues.join(' | '), /no native calendar provider is selected/);
  assert.equal(readiness.defaultCalendarConfigured, false);
  db.close();
});

test('readiness: a provider with nothing schedulable is not ready', () => {
  const { db, configService } = fixture({ targets: { provider: 'reference' } });
  const readiness = evaluateSchedulingReadiness({ configService, organizationKey: FIRM });
  assert.equal(readiness.ready, false);
  assert.match(readiness.issues.join(' | '), /no route is schedulable/);
  db.close();
});

test('readiness: group coverage via a fully bound member pool is recognized', () => {
  const { db, configService } = fixture({
    targets: { ...GOOD_TARGETS, routingGroupCalendars: {} },
  });
  const readiness = evaluateSchedulingReadiness({ configService, organizationKey: FIRM });
  assert.deepEqual(readiness.routingGroups[0], {
    key: 'probate', serviceArea: 'probate', active: true, covered: true, via: 'member-pool',
  });
  db.close();
});
