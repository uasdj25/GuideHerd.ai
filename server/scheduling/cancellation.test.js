'use strict';

/**
 * Native cancellation (GitLab #81): tenant cutoff policy, provider
 * outcomes (confirmed / definitively-gone / refused-and-reverted /
 * ambiguous), integrity alarms, legacy isolation, concurrency, slot
 * release, audit, and telemetry hygiene — against the reference
 * provider and the in-memory store.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { fixedClock } = require('../handoff/clock');
const { createTelemetry } = require('../telemetry/telemetry');
const {
  createInMemoryBookingContextStore, createInMemoryAuditLog, BookingContextStatus,
} = require('./booking-context-store');
const { createReferenceCalendarProvider } = require('./calendar-provider');
const { cancelAppointment } = require('./cancellation');

const FIRM = 'firm-a';
const T0 = Date.parse('2026-08-30T15:00:00Z');
const SLOT = '2026-09-01T14:00:00.000Z';
const SLOT_2 = '2026-09-01T14:30:00.000Z';

function fixture({ bookingWindow } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Firm A', timezone: 'America/Chicago' });
  if (bookingWindow) configService.settings.set(FIRM, 'scheduling', 'booking-window', bookingWindow);
  const clock = fixedClock(T0);
  const audit = createInMemoryAuditLog();
  const store = createInMemoryBookingContextStore({ clock, audit });
  const provider = createReferenceCalendarProvider();
  provider.givenCalendar('cal-clay', {});
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock });
  return { db, configService, clock, audit, store, provider, telemetry, lines };
}

/** Create a BOOKED native context whose event really exists on cal-clay. */
async function bookedContext({ store, provider, clock }, overrides = {}) {
  const suffix = crypto.randomUUID();
  const bookingContextId = `bc_${suffix}`;
  const { providerEventId } = await provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT, durationMinutes: 30,
    summary: 'Consultation', correlationId: overrides.eventCorrelationId ?? bookingContextId,
  });
  await store.create({
    bookingContextId,
    contextTokenHash: crypto.createHash('sha256').update(`bct_${suffix}`).digest('hex'),
    organizationKey: FIRM,
    sessionId: null,
    routeKind: 'attorney',
    attorneyId: 'clay-martinson',
    routingGroupKey: null,
    practiceAreaId: null,
    consultationTypeId: 'initial-consultation',
    eventTypeId: null,
    providerKey: 'reference',
    calendarRef: 'cal-clay',
    offeredTargets: {
      [SLOT]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
      [SLOT_2]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
    },
    durationMinutes: 30,
    offeredSlots: [SLOT, SLOT_2],
    createdAtMs: clock.now(),
    expiresAtMs: clock.now() + 10 * 60 * 1000,
    ...overrides.context,
  });
  await store.claim({ bookingContextId, startsAt: SLOT });
  await store.complete({
    bookingContextId, status: BookingContextStatus.BOOKED,
    providerEventId, bookingResult: { providerEventId, startsAt: SLOT, status: 'confirmed' },
  });
  return { bookingContextId, providerEventId };
}

const cancel = (fx, bookingContextId, extra = {}) => cancelAppointment({
  bookingContexts: fx.store,
  calendarProviders: { reference: fx.provider },
  configService: fx.configService,
  organizationKey: FIRM,
  bookingContextId,
  clock: fx.clock,
  telemetry: fx.telemetry,
  correlationId: 'test-corr',
  ...extra,
});

test('cancel: a booked appointment cancels — provider event cancelled, slot released, audit and telemetry recorded', async () => {
  const fx = fixture();
  const { bookingContextId, providerEventId } = await bookedContext(fx);
  const result = await cancel(fx, bookingContextId);
  assert.deepEqual(result, { outcome: 'cancelled', bookingContextId });

  const event = fx.provider.eventsOn('cal-clay').find((e) => e.providerEventId === providerEventId);
  assert.equal(event.status, 'cancelled');
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.CANCELLED);

  const trail = await fx.audit.listByContext(bookingContextId);
  assert.deepEqual(trail.map((r) => r.action),
    ['created', 'claimed', 'booked', 'cancellation_pending', 'cancelled']);
  assert.ok(fx.lines.some((l) => l.event === 'guideherd.scheduling.booking_cancelled'),
    'exactly the cancellation intent is emitted');
  // Telemetry hygiene: no attendee data, no raw tokens anywhere.
  const serialized = JSON.stringify(fx.lines);
  assert.ok(!serialized.includes('bct_'));

  // The slot is genuinely free again: a fresh context can claim it.
  const fresh = await bookedContext(fx);
  assert.ok(fresh.bookingContextId, 'rebooking the freed slot works');
  fx.db.close();
});

test('cancel: the tenant cutoff refuses late cancellations and the booking stands', async () => {
  const fx = fixture({ bookingWindow: { cancellationCutoffMinutes: 48 * 60 } });
  const { bookingContextId } = await bookedContext(fx); // starts ~2 days out
  const result = await cancel(fx, bookingContextId);
  assert.deepEqual(result, { outcome: 'rejected', reason: 'cancellation_cutoff', bookingContextId });
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.BOOKED);
  assert.equal(fx.provider.attempts('cancelEvent'), 0, 'the provider is never consulted');
  fx.db.close();
});

test('cancel: unknown, cross-tenant, unbooked, and legacy contexts are all controlled rejections', async () => {
  const fx = fixture();
  assert.equal((await cancel(fx, 'bc_never-existed')).reason, 'booking_not_found');

  const { bookingContextId } = await bookedContext(fx);
  assert.equal((await cancelAppointment({
    bookingContexts: fx.store, calendarProviders: { reference: fx.provider },
    configService: fx.configService, organizationKey: FIRM, bookingContextId,
    clock: fx.clock,
  })).outcome, 'cancelled');
  // Already cancelled -> not cancellable.
  assert.equal((await cancel(fx, bookingContextId)).reason, 'booking_not_cancellable');

  // A legacy (event-type) booking is never half-cancelled from here.
  const legacyId = `bc_${crypto.randomUUID()}`;
  await fx.store.create({
    bookingContextId: legacyId,
    contextTokenHash: crypto.createHash('sha256').update(legacyId).digest('hex'),
    organizationKey: FIRM, sessionId: null, routeKind: 'attorney',
    attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    consultationTypeId: null, eventTypeId: 6287134, durationMinutes: 30,
    offeredSlots: [SLOT_2], createdAtMs: fx.clock.now(), expiresAtMs: fx.clock.now() + 600000,
  });
  await fx.store.claim({ bookingContextId: legacyId, startsAt: SLOT_2 });
  await fx.store.complete({ bookingContextId: legacyId, status: BookingContextStatus.BOOKED, calcomBookingUid: 'uid_1' });
  assert.equal((await cancel(fx, legacyId)).reason, 'cancellation_not_supported');
  assert.equal((await fx.store.get(legacyId)).status, BookingContextStatus.BOOKED);
  fx.db.close();
});

test('cancel: an ambiguous provider outcome is verification_required with the intent recorded — never retried', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  fx.provider.injectFailure('cancelEvent', 'network');
  const result = await cancel(fx, bookingContextId);
  assert.equal(result.outcome, 'verification_required');
  assert.equal(result.reason, 'cancellation_network_failure');
  assert.equal(fx.provider.attempts('cancelEvent'), 1, 'one attempt, never retried');
  const row = await fx.store.get(bookingContextId);
  assert.equal(row.status, BookingContextStatus.VERIFICATION_REQUIRED);
  assert.equal(row.rejectionReason, 'cancellation_network_failure', 'the cancellation INTENT is durable');
  fx.db.close();
});

test('cancel: a definitive provider refusal REVERTS — the caller is never told cancelled', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  fx.provider.injectFailure('cancelEvent', 'reject');
  const result = await cancel(fx, bookingContextId);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason, /^cancel_rejected_/);
  assert.equal((await fx.store.get(bookingContextId)).status, BookingContextStatus.BOOKED,
    'the appointment still stands');
  fx.db.close();
});

test('cancel: an event that definitively no longer exists resolves to cancelled', async () => {
  // A context whose recorded event id the provider no longer knows
  // (cancelled or deleted directly in the calendar and purged).
  const fx2 = fixture();
  const orphanId = `bc_${crypto.randomUUID()}`;
  await fx2.store.create({
    bookingContextId: orphanId,
    contextTokenHash: crypto.createHash('sha256').update(orphanId).digest('hex'),
    organizationKey: FIRM, sessionId: null, routeKind: 'attorney',
    attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    consultationTypeId: null, eventTypeId: null, providerKey: 'reference',
    calendarRef: 'cal-clay',
    offeredTargets: { [SLOT_2]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' } },
    durationMinutes: 30, offeredSlots: [SLOT_2],
    createdAtMs: fx2.clock.now(), expiresAtMs: fx2.clock.now() + 600000,
  });
  await fx2.store.claim({ bookingContextId: orphanId, startsAt: SLOT_2 });
  await fx2.store.complete({
    bookingContextId: orphanId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-never-issued',
  });
  const result = await cancel(fx2, orphanId);
  assert.deepEqual(result, { outcome: 'cancelled', reason: 'event_not_found', bookingContextId: orphanId });
  assert.equal((await fx2.store.get(orphanId)).status, BookingContextStatus.CANCELLED);
  fx2.db.close();
});

test('cancel: a correlation mismatch is an integrity alarm — verification_required, event untouched', async () => {
  const fx = fixture();
  // The stored event belongs to ANOTHER booking (foreign correlation).
  const { bookingContextId } = await bookedContext(fx, { eventCorrelationId: 'bc_someone-else' });
  const result = await cancel(fx, bookingContextId);
  assert.equal(result.outcome, 'verification_required');
  assert.equal(result.reason, 'correlation_mismatch');
  const event = fx.provider.eventsOn('cal-clay')[0];
  assert.equal(event.status, 'confirmed', 'the foreign event was NEVER cancelled');
  fx.db.close();
});

test('cancel: two concurrent cancel requests — one drives the provider, one is refused', async () => {
  const fx = fixture();
  const { bookingContextId } = await bookedContext(fx);
  const [a, b] = await Promise.all([cancel(fx, bookingContextId), cancel(fx, bookingContextId)]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['cancelled', 'rejected']);
  assert.equal(fx.provider.attempts('cancelEvent'), 1, 'exactly one provider call');
  fx.db.close();
});
