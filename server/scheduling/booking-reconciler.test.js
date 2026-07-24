'use strict';

/**
 * Evidence-based reconciliation (GitLab #87): every ambiguity kind
 * resolved from provider evidence only — creation, cancellation, and
 * reschedule pairs, in both directions — plus the never-guess rules
 * (provider unreachable stays queued; absent reschedule evidence is the
 * operator's; legacy rows skipped; no provider writes, ever).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { fixedClock } = require('../handoff/clock');
const { createTelemetry } = require('../telemetry/telemetry');
const {
  createInMemoryBookingContextStore, createInMemoryAuditLog, BookingContextStatus,
} = require('./booking-context-store');
const { createReferenceCalendarProvider } = require('./calendar-provider');
const { reconcileVerificationRequired } = require('./booking-reconciler');

const FIRM = 'firm-a';
const T0 = Date.parse('2026-08-30T15:00:00Z');
const SLOT = '2026-09-01T14:00:00.000Z';
const SLOT_NEW = '2026-09-01T15:00:00.000Z';

function fixture() {
  const clock = fixedClock(T0);
  const store = createInMemoryBookingContextStore({ clock, audit: createInMemoryAuditLog() });
  const provider = createReferenceCalendarProvider();
  provider.givenCalendar('cal-clay', {});
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock });
  const run = () => reconcileVerificationRequired({
    bookingContexts: store, calendarProviders: { reference: provider }, telemetry,
  });
  return { clock, store, provider, telemetry, lines, run };
}

async function nativeContext(fx, overrides = {}) {
  const suffix = crypto.randomUUID();
  const bookingContextId = `bc_${suffix}`;
  await fx.store.create({
    bookingContextId,
    contextTokenHash: crypto.createHash('sha256').update(bookingContextId).digest('hex'),
    organizationKey: FIRM, sessionId: null, routeKind: 'attorney',
    attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    consultationTypeId: null, eventTypeId: null,
    providerKey: 'reference', calendarRef: 'cal-clay',
    offeredTargets: {
      [SLOT]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
      [SLOT_NEW]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
    },
    durationMinutes: 30, offeredSlots: [SLOT, SLOT_NEW],
    createdAtMs: fx.clock.now(), expiresAtMs: fx.clock.now() + 600000,
    ...overrides,
  });
  return bookingContextId;
}

/** Park a context in verification_required with the given reason. */
async function parkVerification(fx, bookingContextId, reason, { startsAt = SLOT } = {}) {
  await fx.store.claim({ bookingContextId, startsAt });
  await fx.store.complete({
    bookingContextId, status: BookingContextStatus.VERIFICATION_REQUIRED, rejectionReason: reason,
  });
}

test('reconciler: creation ambiguity — the event EXISTS, so the booking resolves booked with the recovered id', async () => {
  const fx = fixture();
  const id = await nativeContext(fx);
  // The ambiguous-but-created case: the event is on the calendar.
  const { providerEventId } = await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT, durationMinutes: 30, summary: 'C', correlationId: id,
  });
  await parkVerification(fx, id, 'provider_timeout');
  const result = await fx.run();
  assert.deepEqual(result, { examined: 1, resolved: 1, left: 0 });
  const row = await fx.store.get(id);
  assert.equal(row.status, BookingContextStatus.BOOKED);
  assert.equal(row.providerEventId, providerEventId);
  assert.ok(fx.lines.some((l) => l.event === 'guideherd.scheduling.booking_reconciled'));
});

test('reconciler: creation ambiguity — the provider positively answers NOTHING, so it resolves rejected', async () => {
  const fx = fixture();
  const id = await nativeContext(fx);
  await parkVerification(fx, id, 'network_failure');
  const result = await fx.run();
  assert.equal(result.resolved, 1);
  const row = await fx.store.get(id);
  assert.equal(row.status, BookingContextStatus.REJECTED);
  assert.equal(row.rejectionReason, 'reconciled_no_event_found');
});

test('reconciler: cancellation ambiguity — event gone means cancelled; event standing means still booked', async () => {
  const fx = fixture();
  // Case A: the cancel actually landed (event cancelled provider-side).
  const idA = await nativeContext(fx);
  const a = await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT, durationMinutes: 30, summary: 'C', correlationId: idA,
  });
  await fx.provider.cancelEvent({ calendarRef: 'cal-clay', providerEventId: a.providerEventId, correlationId: idA });
  await parkVerification(fx, idA, 'cancellation_network_failure');

  // Case B: the cancel never landed (event still confirmed).
  const idB = await nativeContext(fx);
  await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT_NEW, durationMinutes: 30, summary: 'C', correlationId: idB,
  });
  await parkVerification(fx, idB, 'cancellation_provider_timeout', { startsAt: SLOT_NEW });

  const result = await fx.run();
  assert.equal(result.resolved, 2);
  assert.equal((await fx.store.get(idA)).status, BookingContextStatus.CANCELLED);
  assert.equal((await fx.store.get(idB)).status, BookingContextStatus.BOOKED,
    'the caller was never told cancelled — the appointment stands');
  fx.lines.length = 0;
});

test('reconciler: a reschedule pair resolves BOTH sides from the event\'s actual position', async () => {
  const fx = fixture();
  // Original booked at SLOT with its event; successor parked mid-move.
  const originalId = await nativeContext(fx);
  const { providerEventId } = await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT, durationMinutes: 30, summary: 'C', correlationId: originalId,
  });
  await fx.store.claim({ bookingContextId: originalId, startsAt: SLOT });
  await fx.store.complete({ bookingContextId: originalId, status: BookingContextStatus.BOOKED, providerEventId });
  await fx.store.beginReschedule({ bookingContextId: originalId });
  await fx.store.completeReschedule({
    bookingContextId: originalId, status: BookingContextStatus.VERIFICATION_REQUIRED,
    rejectionReason: 'reschedule_provider_timeout',
  });
  const successorId = await nativeContext(fx, { rescheduleOf: originalId });
  await parkVerification(fx, successorId, 'reschedule_provider_timeout', { startsAt: SLOT_NEW });

  // Direction 1: the move DID happen — the event sits at the new time.
  await fx.provider.updateEvent({
    calendarRef: 'cal-clay', providerEventId, correlationId: originalId, startsAt: SLOT_NEW,
  });
  const result = await fx.run();
  assert.equal((await fx.store.get(successorId)).status, BookingContextStatus.BOOKED);
  assert.equal((await fx.store.get(successorId)).providerEventId, providerEventId);
  assert.equal((await fx.store.get(originalId)).status, BookingContextStatus.RESCHEDULED);
  assert.ok(result.resolved >= 2);
});

test('reconciler: a reschedule pair whose event never moved reverts the original and rejects the successor', async () => {
  const fx = fixture();
  const originalId = await nativeContext(fx);
  const { providerEventId } = await fx.provider.createEvent({
    calendarRef: 'cal-clay', startsAt: SLOT, durationMinutes: 30, summary: 'C', correlationId: originalId,
  });
  await fx.store.claim({ bookingContextId: originalId, startsAt: SLOT });
  await fx.store.complete({ bookingContextId: originalId, status: BookingContextStatus.BOOKED, providerEventId });
  await fx.store.beginReschedule({ bookingContextId: originalId });
  await fx.store.completeReschedule({
    bookingContextId: originalId, status: BookingContextStatus.VERIFICATION_REQUIRED,
    rejectionReason: 'reschedule_provider_timeout',
  });
  const successorId = await nativeContext(fx, { rescheduleOf: originalId });
  await parkVerification(fx, successorId, 'reschedule_provider_timeout', { startsAt: SLOT_NEW });

  await fx.run();
  assert.equal((await fx.store.get(successorId)).status, BookingContextStatus.REJECTED);
  assert.equal((await fx.store.get(originalId)).status, BookingContextStatus.BOOKED, 'reverted');
});

test('reconciler: provider unreachable — the context STAYS queued, loudly; nothing is invented', async () => {
  const fx = fixture();
  const id = await nativeContext(fx);
  await parkVerification(fx, id, 'provider_timeout');
  fx.provider.injectFailure('findEventByCorrelation', 'timeout');
  const result = await fx.run();
  assert.deepEqual(result, { examined: 1, resolved: 0, left: 1 });
  assert.equal((await fx.store.get(id)).status, BookingContextStatus.VERIFICATION_REQUIRED);
  assert.ok(fx.lines.some((l) => l.event === 'guideherd.scheduling.booking_verification_required'
    && l.code === 'reconciliation_evidence_unavailable'));
  // The next run (provider healthy again) resolves it.
  const second = await fx.run();
  assert.equal(second.resolved, 1);
});

test('reconciler: legacy contexts and unknown providers are left for the manual procedure', async () => {
  const fx = fixture();
  const legacyId = `bc_${crypto.randomUUID()}`;
  await fx.store.create({
    bookingContextId: legacyId,
    contextTokenHash: crypto.createHash('sha256').update(legacyId).digest('hex'),
    organizationKey: FIRM, sessionId: null, routeKind: 'attorney',
    attorneyId: 'clay-martinson', routingGroupKey: null, practiceAreaId: null,
    consultationTypeId: null, eventTypeId: 6287134, durationMinutes: 30,
    offeredSlots: [SLOT], createdAtMs: fx.clock.now(), expiresAtMs: fx.clock.now() + 600000,
  });
  await fx.store.claim({ bookingContextId: legacyId, startsAt: SLOT });
  await fx.store.complete({
    bookingContextId: legacyId, status: BookingContextStatus.VERIFICATION_REQUIRED,
    rejectionReason: 'provider_timeout',
  });
  const result = await fx.run();
  assert.deepEqual(result, { examined: 1, resolved: 0, left: 1 });
  assert.equal((await fx.store.get(legacyId)).status, BookingContextStatus.VERIFICATION_REQUIRED);
  assert.equal(fx.provider.attempts('findEventByCorrelation'), 0);
});
