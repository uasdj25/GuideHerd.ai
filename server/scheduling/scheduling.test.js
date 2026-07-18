'use strict';

/**
 * Scheduling Policy Engine tests (ADR-0012).
 *
 * Deterministic throughout: fixed slot fixtures, no wall clock, no
 * providers. Covers the policy model, every first-set preference, ranking
 * composition, guarded filtering, graceful fallback, provider
 * independence, multi-organization isolation, and the no-policy default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { normalizePolicy, resolveSchedulingPolicy, SETTINGS_NAMESPACE, POLICY_KEY } = require('./policy');
const { selectSlots } = require('./engine');

const TZ = 'America/Chicago';
const FIRM = 'martinson-beason';

// A deterministic week of availability (all times UTC; Chicago is UTC-5).
// 2026-07-20 is a Monday.
function weekSlots() {
  return [
    // Monday morning, Clay, 30m, initial
    { startsAt: '2026-07-20T14:00:00Z', durationMinutes: 30, attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    // Monday afternoon, Morris, 30m, initial
    { startsAt: '2026-07-20T19:00:00Z', durationMinutes: 30, attorneyId: 'morris-lilienthal', consultationTypeId: 'initial-consultation' },
    // Tuesday morning, Morris, 60m, follow-up
    { startsAt: '2026-07-21T15:00:00Z', durationMinutes: 60, attorneyId: 'morris-lilienthal', consultationTypeId: 'follow-up' },
    // Wednesday afternoon, Clay, 30m, initial
    { startsAt: '2026-07-22T20:00:00Z', durationMinutes: 30, attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    // Friday morning, Sarah, 45m, initial
    { startsAt: '2026-07-24T14:30:00Z', durationMinutes: 45, attorneyId: 'sarah-conway', consultationTypeId: 'initial-consultation' },
  ];
}

// ── Policy model ────────────────────────────────────────────────────────────

test('policy: valid documents normalize; malformed fields degrade without breaking valid ones', () => {
  const { policy, issues } = normalizePolicy({
    preferredAttorneys: ['clay-martinson'],
    preferredDaysOfWeek: ['Monday', 'TUESDAY'],
    preferredTimeOfDay: 'Morning',
    preferredDurationMinutes: 30,
    preferredConsultationTypes: ['initial-consultation'],
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(policy.preferredDaysOfWeek, ['monday', 'tuesday']);
  assert.equal(policy.preferredTimeOfDay, 'morning');

  const degraded = normalizePolicy({
    preferredAttorneys: ['clay-martinson'],
    preferredTimeOfDay: 'brunch',          // invalid — dropped
    preferredDurationMinutes: 'thirty',    // invalid — dropped
    futureVipRouting: true,                // unknown — reported
  });
  assert.deepEqual(degraded.policy, { preferredAttorneys: ['clay-martinson'] }, 'valid fields survive');
  assert.equal(degraded.issues.length, 3);

  assert.deepEqual(normalizePolicy(null), { policy: null, issues: [] });
  assert.equal(normalizePolicy('nonsense').policy, null);
});

test('policy: resolves from the Configuration Store per organization; absence means no policy', () => {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: TZ });
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: 'America/New_York' });

  assert.deepEqual(resolveSchedulingPolicy(configService, FIRM), { policy: null, issues: [] }, 'unset -> no policy');
  assert.deepEqual(resolveSchedulingPolicy(null, FIRM), { policy: null, issues: [] });

  configService.settings.set(FIRM, SETTINGS_NAMESPACE, POLICY_KEY, { preferredTimeOfDay: 'morning' });
  assert.deepEqual(resolveSchedulingPolicy(configService, FIRM).policy, { preferredTimeOfDay: 'morning' });

  // Multiple organizations: policies are isolated per firm.
  configService.settings.set('other-firm', SETTINGS_NAMESPACE, POLICY_KEY, { preferredTimeOfDay: 'afternoon' });
  assert.equal(resolveSchedulingPolicy(configService, FIRM).policy.preferredTimeOfDay, 'morning');
  assert.equal(resolveSchedulingPolicy(configService, 'other-firm').policy.preferredTimeOfDay, 'afternoon');
});

// ── No policy: today's behavior is the default ──────────────────────────────

test('engine: with no policy and no request preferences, availability returns chronologically — unchanged behavior', () => {
  const result = selectSlots({ slots: weekSlots(), timezone: TZ });
  assert.deepEqual(result.candidates.map((s) => s.startsAt), [
    '2026-07-20T14:00:00Z', '2026-07-20T19:00:00Z', '2026-07-21T15:00:00Z', '2026-07-22T20:00:00Z', '2026-07-24T14:30:00Z',
  ]);
  assert.ok(result.candidates.every((s) => s.score === 0));
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.fallback, { requestedAttorneyUnavailable: false, consultationTypeRelaxed: false });
});

// ── First policy set ────────────────────────────────────────────────────────

test('engine: preferred attorney ranks first; order in the preference list matters', () => {
  const policy = { preferredAttorneys: ['sarah-conway', 'clay-martinson'] };
  const result = selectSlots({ slots: weekSlots(), policy, timezone: TZ });
  assert.equal(result.candidates[0].attorneyId, 'sarah-conway', 'first-listed attorney outranks');
  assert.equal(result.candidates[1].attorneyId, 'clay-martinson');
  assert.ok(result.applied.includes('preferred-attorney'));
});

test("engine: the caller's own requested attorney outranks the organization's preference", () => {
  const policy = { preferredAttorneys: ['sarah-conway'] };
  const result = selectSlots({
    slots: weekSlots(), policy, timezone: TZ,
    request: { attorneyId: 'morris-lilienthal' },
  });
  assert.equal(result.candidates[0].attorneyId, 'morris-lilienthal');
  assert.ok(result.candidates[0].matchedDimensions.includes('requested-attorney'));
});

test('engine: an unavailable requested attorney falls back gracefully — scheduling never fails', () => {
  const result = selectSlots({
    slots: weekSlots(), timezone: TZ,
    request: { attorneyId: 'no-such-attorney' },
  });
  assert.equal(result.candidates.length, 5, 'every other slot still offered');
  assert.equal(result.fallback.requestedAttorneyUnavailable, true, 'the caller can be told honestly');
});

test('engine: preferred day of week ranks matching days first', () => {
  const policy = { preferredDaysOfWeek: ['friday'] };
  const result = selectSlots({ slots: weekSlots(), policy, timezone: TZ });
  assert.equal(result.candidates[0].startsAt, '2026-07-24T14:30:00Z', 'Friday first');
  assert.ok(result.candidates[0].matchedDimensions.includes('preferred-day'));
});

test('engine: morning/afternoon preference is evaluated in the ORGANIZATION timezone', () => {
  // 14:00Z on Monday is 09:00 in Chicago (morning) but 15:00 in London.
  const morning = selectSlots({ slots: weekSlots(), policy: { preferredTimeOfDay: 'morning' }, timezone: TZ });
  assert.deepEqual(
    morning.candidates.slice(0, 3).map((s) => s.startsAt),
    ['2026-07-20T14:00:00Z', '2026-07-21T15:00:00Z', '2026-07-24T14:30:00Z'],
    'Chicago mornings rank first',
  );
  // In Europe/London (UTC+1 in July) every fixture slot lands after noon:
  // the morning preference matches nothing, so order stays chronological.
  const london = selectSlots({ slots: weekSlots(), policy: { preferredTimeOfDay: 'morning' }, timezone: 'Europe/London' });
  assert.equal(london.candidates[0].startsAt, '2026-07-20T14:00:00Z', 'chronological when no slot matches');
  assert.equal(london.applied.includes('preferred-time-of-day'), false, 'timezone changes the decision');
});

test('engine: preferred consultation duration and type rank matching slots higher', () => {
  const policy = { preferredDurationMinutes: 60, preferredConsultationTypes: ['follow-up'] };
  const result = selectSlots({ slots: weekSlots(), policy, timezone: TZ });
  assert.equal(result.candidates[0].startsAt, '2026-07-21T15:00:00Z', '60m follow-up wins both dimensions');
  assert.deepEqual(result.candidates[0].matchedDimensions.sort(), ['preferred-consultation-type', 'preferred-duration']);
});

test('engine: a requested consultation type filters incompatible slots — guarded, never to empty', () => {
  const filtered = selectSlots({ slots: weekSlots(), timezone: TZ, request: { consultationTypeId: 'initial-consultation' } });
  assert.equal(filtered.candidates.length, 4, 'the follow-up slot is filtered out');
  assert.equal(filtered.fallback.consultationTypeRelaxed, false);

  const relaxed = selectSlots({ slots: weekSlots(), timezone: TZ, request: { consultationTypeId: 'probate-review' } });
  assert.equal(relaxed.candidates.length, 5, 'no matching slots: the filter relaxes rather than failing');
  assert.equal(relaxed.fallback.consultationTypeRelaxed, true);
});

// ── Composition and determinism ─────────────────────────────────────────────

test('engine: policies compose additively — combined preferences select the slot satisfying the most dimensions', () => {
  const policy = {
    preferredAttorneys: ['clay-martinson'],
    preferredDaysOfWeek: ['monday'],
    preferredTimeOfDay: 'morning',
    preferredDurationMinutes: 30,
  };
  const result = selectSlots({ slots: weekSlots(), policy, timezone: TZ });
  const top = result.candidates[0];
  assert.equal(top.startsAt, '2026-07-20T14:00:00Z', 'Monday morning + Clay + 30m wins every dimension');
  assert.deepEqual(top.matchedDimensions.sort(), [
    'preferred-attorney', 'preferred-day', 'preferred-duration', 'preferred-time-of-day',
  ]);
  assert.equal(top.score, 50 + 20 + 20 + 15);
});

test('engine: evaluation is deterministic — identical inputs produce identical output, and ties break by time', () => {
  const policy = { preferredTimeOfDay: 'afternoon' };
  const a = selectSlots({ slots: weekSlots(), policy, timezone: TZ });
  const b = selectSlots({ slots: weekSlots(), policy, timezone: TZ });
  assert.deepEqual(a, b, 'pure function of inputs');

  // Two afternoon slots tie on score: earlier start wins.
  assert.deepEqual(a.candidates.slice(0, 2).map((s) => s.startsAt), ['2026-07-20T19:00:00Z', '2026-07-22T20:00:00Z']);
});

// ── Provider independence ───────────────────────────────────────────────────

test('engine: slots are neutral — provider payload fields are dropped and malformed slots never break selection', () => {
  const slots = [
    { startsAt: '2026-07-20T14:00:00Z', attorneyId: 'clay-martinson', calcomEventTypeId: 12345, rawPayload: { deep: true } },
    { startsAt: 'not-a-date', attorneyId: 'broken' },
    null,
    { noStart: true },
  ];
  const result = selectSlots({ slots, timezone: TZ });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.droppedSlots, 3, 'malformed slots dropped and counted');
  const flat = JSON.stringify(result);
  assert.equal(/calcom|rawPayload|12345/.test(flat), false, 'provider fields never cross the boundary');
});

test('engine: limit caps candidates; empty availability returns an empty, well-formed result', () => {
  const limited = selectSlots({ slots: weekSlots(), timezone: TZ, limit: 2 });
  assert.equal(limited.candidates.length, 2);
  const empty = selectSlots({ slots: [], timezone: TZ });
  assert.deepEqual(empty.candidates, []);
  assert.deepEqual(empty.fallback, { requestedAttorneyUnavailable: false, consultationTypeRelaxed: false });
});
