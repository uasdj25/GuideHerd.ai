'use strict';

/**
 * Native rescheduling (GitLab #82): governed re-offer on the same
 * target, the never-zero-never-two invariant across every failure path,
 * lineage, cutoff policy, and route-lock — against the reference
 * provider and the in-memory store.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { fixedClock } = require('../handoff/clock');
const {
  createInMemoryBookingContextStore, createInMemoryAuditLog, BookingContextStatus,
} = require('./booking-context-store');
const { createReferenceCalendarProvider } = require('./calendar-provider');
const { offerReschedule, confirmReschedule } = require('./reschedule');

const FIRM = 'firm-a';
const T0 = Date.parse('2026-08-25T15:00:00Z');
const SLOT = '2026-09-01T14:00:00.000Z';   // Tue 09:00 CDT
const SLOT_2 = '2026-09-01T14:30:00.000Z';
const WEEK = { dateFrom: '2026-09-01', dateTo: '2026-09-04' };
const HOURS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opens: '09:00', closes: '17:00' }));

function fixture({ bookingWindow } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Firm A', timezone: 'America/Chicago' });
  configService.locations.create(FIRM, { key: 'main', name: 'Main', timezone: 'America/Chicago', officeHours: HOURS });
  if (bookingWindow) configService.settings.set(FIRM, 'scheduling', 'booking-window', bookingWindow);
  const clock = fixedClock(T0);
  const audit = createInMemoryAuditLog();
  const store = createInMemoryBookingContextStore({ clock, audit });
  const provider = createReferenceCalendarProvider();
  provider.givenCalendar('cal-clay', {});
  return { db, configService, clock, audit, store, provider };
}

async function bookedContext(fx) {
  const suffix = crypto.randomUUID();
  const bookingContextId = `bc_${suffix}`;
  const { providerEventId } = await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT, durationMinutes: 30,
    summary: 'Consultation', correlationId: bookingContextId,
  });
  await fx.store.create({
    bookingContextId,
    contextTokenHash: crypto.createHash('sha256').update(`bct_${suffix}`).digest('hex'),
    organizationKey: FIRM, sessionId: null, routeKind: 'attorney',
    attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    consultationTypeId: 'initial-consultation', eventTypeId: null,
    providerKey: 'reference', calendarRef: 'cal-clay',
    offeredTargets: { [SLOT]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' } },
    durationMinutes: 30, offeredSlots: [SLOT],
    createdAtMs: fx.clock.now(), expiresAtMs: fx.clock.now() + 600000,
  });
  await fx.store.claim({ bookingContextId, startsAt: SLOT });
  await fx.store.complete({
    bookingContextId, status: BookingContextStatus.BOOKED,
    providerEventId, bookingResult: { providerEventId, startsAt: SLOT, status: 'confirmed' },
  });
  return { bookingContextId, providerEventId };
}

const offer = (fx, bookingContextId) => offerReschedule({
  bookingContexts: fx.store, calendarProviders: { reference: fx.provider },
  configService: fx.configService, organizationKey: FIRM,
  bookingContextId, request: WEEK, clock: fx.clock,
});
const confirm = (fx, rescheduleContextId, startsAt) => confirmReschedule({
  bookingContexts: fx.store, calendarProviders: { reference: fx.provider },
  organizationKey: FIRM, rescheduleContextId, startsAt, clock: fx.clock,
});

/** Count LIVE appointments across the pair: booked statuses only. */
async function liveCount(fx, ids) {
  let n = 0;
  for (const id of ids) {
    const row = await fx.store.get(id);
    if (row && row.status === BookingContextStatus.BOOKED) n += 1;
  }
  return n;
}

test('reschedule: happy path — same target, event moved, lineage recorded, exactly one live appointment', async () => {
  const fx = fixture();
  const { bookingContextId, providerEventId } = await bookedContext(fx);
  const offered = await offer(fx, bookingContextId);
  assert.equal(offered.kind, 'offered');
  assert.equal(offered.slots.length, 2);
  assert.ok(offered.slots.every((s) => s.attorneyId === 'clay-martinson'), 'route lock: same attorney only');
  assert.ok(!offered.slots.some((s) => s.startsAt === SLOT), 'the current time is never re-offered');

  const target = offered.slots[0].startsAt;
  const result = await confirm(fx, offered.rescheduleContextId, target);
  assert.equal(result.outcome, 'rescheduled');
  assert.equal(result.startsAt, target);
  assert.equal(result.originalBookingContextId, bookingContextId);

  const event = fx.provider.eventsOn('cal-clay').find((e) => e.providerEventId === providerEventId);
  assert.equal(event.startsAt, target, 'the SAME provider event moved');
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.RESCHEDULED);
  const successor = await fx.store.get(offered.rescheduleContextId);
  assert.equal(successor.status, BookingContextStatus.BOOKED);
  assert.equal(successor.providerEventId, providerEventId);
  assert.equal(successor.rescheduleOf, bookingContextId, 'lineage queryable');
  assert.equal(await liveCount(fx, [bookingContextId, offered.rescheduleContextId]), 1);
  fx.db.close();
});

test('reschedule: a definitive provider refusal reverts — the appointment stands at its original time', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  const offered = await offer(fx, bookingContextId);
  fx.provider.injectFailure('updateEvent', 'reject');
  const result = await confirm(fx, offered.rescheduleContextId, offered.slots[0].startsAt);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason, /^reschedule_rejected_/);
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.BOOKED, 'reverted');
  assert.equal(await liveCount(fx, [bookingContextId, offered.rescheduleContextId]), 1);
  const event = fx.provider.eventsOn('cal-clay')[0];
  assert.equal(event.startsAt, SLOT, 'the event never moved');
  fx.db.close();
});

test('reschedule: an ambiguous update parks BOTH sides in verification_required — never zero, never two', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  const offered = await offer(fx, bookingContextId);
  fx.provider.injectFailure('updateEvent', 'timeout');
  const result = await confirm(fx, offered.rescheduleContextId, offered.slots[0].startsAt);
  assert.equal(result.outcome, 'verification_required');
  assert.equal(fx.provider.attempts('updateEvent'), 1, 'never retried');
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.VERIFICATION_REQUIRED);
  assert.equal((await fx.store.get(offered.rescheduleContextId)).status, BookingContextStatus.VERIFICATION_REQUIRED);
  assert.equal(await liveCount(fx, [bookingContextId, offered.rescheduleContextId]), 0,
    'no false live appointment while the truth is unknown');
  fx.db.close();
});

test('reschedule: cutoff policy refuses; unknown/legacy/non-booked are controlled rejections', async () => {
  const fx = fixture({ bookingWindow: { rescheduleCutoffMinutes: 14 * 24 * 60 } });
  const { bookingContextId } = await bookedContext(fx); // ~7 days out < 14-day cutoff
  assert.equal((await offer(fx, bookingContextId)).reason, 'reschedule_cutoff');

  const fx2 = fixture();
  assert.equal((await offer(fx2, 'bc_ghost')).reason, 'booking_not_found');
  const legacyId = `bc_${crypto.randomUUID()}`;
  await fx2.store.create({
    bookingContextId: legacyId,
    contextTokenHash: crypto.createHash('sha256').update(legacyId).digest('hex'),
    organizationKey: FIRM, sessionId: null, routeKind: 'attorney',
    attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    consultationTypeId: null, eventTypeId: 6287134, durationMinutes: 30,
    offeredSlots: [SLOT], createdAtMs: fx2.clock.now(), expiresAtMs: fx2.clock.now() + 600000,
  });
  await fx2.store.claim({ bookingContextId: legacyId, startsAt: SLOT });
  await fx2.store.complete({ bookingContextId: legacyId, status: BookingContextStatus.BOOKED, calcomBookingUid: 'u1' });
  assert.equal((await offer(fx2, legacyId)).reason, 'reschedule_not_supported');
  fx.db.close();
  fx2.db.close();
});

test('reschedule: the original disappearing mid-flow rejects the successor cleanly', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  const offered = await offer(fx, bookingContextId);
  // The original gets cancelled between offer and confirm.
  await fx.store.beginCancellation({ bookingContextId });
  await fx.store.completeCancellation({ bookingContextId, status: BookingContextStatus.CANCELLED });
  const result = await confirm(fx, offered.rescheduleContextId, offered.slots[0].startsAt);
  assert.equal(result.reason, 'reschedule_original_not_booked');
  assert.equal((await fx.store.get(offered.rescheduleContextId)).status, BookingContextStatus.REJECTED);
  assert.equal(fx.provider.attempts('updateEvent'), 0);
  fx.db.close();
});

test('reschedule: concurrent confirms — exactly one provider update, one winner', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  const offered = await offer(fx, bookingContextId);
  const [a, b] = await Promise.all([
    confirm(fx, offered.rescheduleContextId, offered.slots[0].startsAt),
    confirm(fx, offered.rescheduleContextId, offered.slots[1].startsAt),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['rejected', 'rescheduled']);
  assert.equal(fx.provider.attempts('updateEvent'), 1);
  fx.db.close();
});

test('reschedule: a busy re-check conflict rejects and reverts; the original interval never blocks its own move', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  const offered = await offer(fx, bookingContextId);
  // An adjacent overlapping slot appears externally before confirm.
  const target = offered.slots[0].startsAt;
  await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: target, durationMinutes: 30,
    summary: 'External', correlationId: 'bc_external',
  });
  const result = await confirm(fx, offered.rescheduleContextId, target);
  assert.equal(result.reason, 'slot_no_longer_available');
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.BOOKED, 'reverted');

  // Moving INTO an interval overlapping only the original's own slot
  // works: offer again — the original's interval is excluded from busy,
  // so 09:30 (overlapping nothing else) is offerable and confirmable.
  const offered2 = await offer(fx, bookingContextId);
  assert.equal(offered2.kind, 'offered');
  assert.ok(!offered2.slots.some((s) => s.startsAt === target), 'the externally taken slot is gone');
  const second = await confirm(fx, offered2.rescheduleContextId, offered2.slots[0].startsAt);
  assert.equal(second.outcome, 'rescheduled');
  fx.db.close();
});
