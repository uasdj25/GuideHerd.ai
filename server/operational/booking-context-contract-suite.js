'use strict';

/**
 * Shared booking-context repository contract suite.
 *
 * Every behavioral guarantee of the booking-context state machine,
 * expressed against the repository CONTRACT rather than an implementation
 * — the same suite runs against the in-memory reference store and the
 * PostgreSQL store, so the two can never drift apart silently.
 *
 * All data is synthetic. All time comes from the injected fixed clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { fixedClock } = require('../handoff/clock');
const { BookingContextStatus, STALE_BOOKING_MS, createInMemoryAuditLog } = require('../scheduling/booking-context-store');

const T0 = Date.parse('2026-09-01T15:00:00Z');
const TTL_MS = 10 * 60 * 1000;

const SLOT_A = '2026-09-01T14:00:00.000Z';
const SLOT_B = '2026-09-01T14:30:00.000Z';

function hash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A synthetic attorney-routed context in 'offered' state. */
function makeContext(overrides = {}) {
  const suffix = crypto.randomUUID();
  return {
    bookingContextId: `bc_${suffix}`,
    contextTokenHash: hash(`bct_${suffix}`),
    organizationKey: 'org-a',
    sessionId: null,
    routeKind: 'attorney',
    attorneyId: 'clay-martinson',
    routingGroupKey: null,
    practiceAreaId: null,
    consultationTypeId: 'initial-consultation',
    eventTypeId: 6287134,
    durationMinutes: 30,
    offeredSlots: [SLOT_A, SLOT_B],
    createdAtMs: T0,
    expiresAtMs: T0 + TTL_MS,
    ...overrides,
  };
}

/**
 * @param {string} label implementation name for test titles
 * @param {(deps: { clock: import('../handoff/clock').Clock }) => Promise<object>} makeStore
 */
/** A synthetic NATIVE attorney-routed context in 'offered' state. */
function makeNativeContext(overrides = {}) {
  return makeContext({
    eventTypeId: null,
    providerKey: 'reference',
    calendarRef: 'cal-clay',
    offeredTargets: {
      [SLOT_A]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
      [SLOT_B]: { attorneyId: 'clay-martinson', calendarRef: 'cal-clay' },
    },
    ...overrides,
  });
}

function runBookingContextContractSuite(label, makeStore) {
  test(`booking-context contract [${label}]: create returns an offered context without the token hash`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext();
    const created = await store.create(input);
    assert.equal(created.status, BookingContextStatus.OFFERED);
    assert.equal(created.bookingContextId, input.bookingContextId);
    assert.equal(created.eventTypeId, 6287134);
    assert.deepEqual(created.offeredSlots, [SLOT_A, SLOT_B]);
    assert.equal(created.contextTokenHash, undefined, 'the token hash is never returned');
    assert.equal(Object.values(created).includes(input.contextTokenHash), false);
  });

  test(`booking-context contract [${label}]: route-kind consistency is enforced on create`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const cases = [
      makeContext({ routeKind: 'attorney', attorneyId: null }),
      makeContext({ routeKind: 'attorney', routingGroupKey: 'probate' }),
      makeContext({ routeKind: 'routing-group', attorneyId: null, routingGroupKey: 'probate', practiceAreaId: null }),
      makeContext({ routeKind: 'routing-group', attorneyId: 'clay-martinson', routingGroupKey: 'probate', practiceAreaId: 'probate' }),
      makeContext({ routeKind: 'default', attorneyId: 'clay-martinson' }),
      makeContext({ routeKind: 'walk-in', attorneyId: null }),
      makeContext({ eventTypeId: 0 }),
      makeContext({ eventTypeId: 1.5 }),
      makeContext({ durationMinutes: 0 }),
      makeContext({ offeredSlots: [] }),
      makeContext({ offeredSlots: ['not a timestamp'] }),
    ];
    for (const bad of cases) {
      await assert.rejects(() => store.create(bad), TypeError, JSON.stringify(bad.routeKind));
    }
    // The valid shapes of every kind are accepted.
    await store.create(makeContext());
    await store.create(makeContext({
      routeKind: 'routing-group', attorneyId: null, routingGroupKey: 'probate',
      practiceAreaId: 'probate', eventTypeId: 6330099,
    }));
    await store.create(makeContext({ routeKind: 'default', attorneyId: null }));
  });

  test(`booking-context contract [${label}]: the token hash is UNIQUE — a colliding create is rejected`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext();
    await store.create(input);
    await assert.rejects(() => store.create(makeContext({ contextTokenHash: input.contextTokenHash })));
  });

  test(`booking-context contract [${label}]: token-hash lookup is tenant-scoped — cross-tenant is indistinguishable from unknown`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext();
    await store.create(input);
    const found = await store.findByTokenHash({ contextTokenHash: input.contextTokenHash, organizationKey: 'org-a' });
    assert.equal(found.bookingContextId, input.bookingContextId);
    assert.equal(
      await store.findByTokenHash({ contextTokenHash: input.contextTokenHash, organizationKey: 'org-b' }),
      null, 'cross-tenant lookup returns null',
    );
    assert.equal(
      await store.findByTokenHash({ contextTokenHash: hash('never-issued'), organizationKey: 'org-a' }),
      null,
    );
  });

  test(`booking-context contract [${label}]: claim is single-use — two concurrent claims, exactly one succeeds`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext();
    await store.create(input);
    const [a, b] = await Promise.all([
      store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A }),
      store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_B }),
    ]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one concurrent claim succeeds');
    assert.equal(winners[0].status, BookingContextStatus.BOOKING_IN_PROGRESS);
    // A later claim also fails.
    assert.equal(await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A }), null);
  });

  test(`booking-context contract [${label}]: expiry is authoritative — an expired context cannot be claimed and reads as expired`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext();
    await store.create(input);
    clock.advance(TTL_MS + 1);
    assert.equal(await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A }), null);
    const read = await store.findByTokenHash({ contextTokenHash: input.contextTokenHash, organizationKey: 'org-a' });
    assert.equal(read.status, BookingContextStatus.EXPIRED);
  });

  test(`booking-context contract [${label}]: complete records booked with uid and sanitized result — and only from booking_in_progress`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext();
    await store.create(input);
    // Not claimable to booked directly.
    assert.equal(await store.complete({
      bookingContextId: input.bookingContextId, status: BookingContextStatus.BOOKED,
    }), null, 'complete() without a claim records nothing');
    await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A });
    const booked = await store.complete({
      bookingContextId: input.bookingContextId,
      status: BookingContextStatus.BOOKED,
      calcomBookingUid: 'uid_123',
      bookingResult: { uid: 'uid_123', start: SLOT_A, status: 'accepted' },
    });
    assert.equal(booked.status, BookingContextStatus.BOOKED);
    assert.equal(booked.calcomBookingUid, 'uid_123');
    assert.deepEqual(booked.bookingResult, { uid: 'uid_123', start: SLOT_A, status: 'accepted' });
    assert.equal(new Date(booked.selectedStartsAt).getTime(), Date.parse(SLOT_A));
    // Terminal rows never transition again.
    assert.equal(await store.complete({
      bookingContextId: input.bookingContextId, status: BookingContextStatus.REJECTED,
    }), null);
    // Invalid target statuses are a programming error.
    await assert.rejects(() => store.complete({
      bookingContextId: input.bookingContextId, status: 'offered',
    }), TypeError);
  });

  test(`booking-context contract [${label}]: complete records rejected and verification_required with reasons`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeContext();
    const b = makeContext();
    await store.create(a);
    await store.create(b);
    await store.claim({ bookingContextId: a.bookingContextId, startsAt: SLOT_A });
    await store.claim({ bookingContextId: b.bookingContextId, startsAt: SLOT_B });
    const rejected = await store.complete({
      bookingContextId: a.bookingContextId, status: BookingContextStatus.REJECTED,
      rejectionReason: 'provider_rejected_400',
    });
    assert.equal(rejected.status, BookingContextStatus.REJECTED);
    assert.equal(rejected.rejectionReason, 'provider_rejected_400');
    const unverified = await store.complete({
      bookingContextId: b.bookingContextId, status: BookingContextStatus.VERIFICATION_REQUIRED,
      rejectionReason: 'provider_timeout',
    });
    assert.equal(unverified.status, BookingContextStatus.VERIFICATION_REQUIRED);
  });

  test(`booking-context contract [${label}]: reconcileStale flips only stranded booking_in_progress rows`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const stranded = makeContext();
    const fresh = makeContext();
    const untouched = makeContext();
    await store.create(stranded);
    await store.create(fresh);
    await store.create(untouched);
    await store.claim({ bookingContextId: stranded.bookingContextId, startsAt: SLOT_A });
    clock.advance(STALE_BOOKING_MS + 1);
    await store.claim({ bookingContextId: fresh.bookingContextId, startsAt: SLOT_A });
    const flipped = await store.reconcileStale({});
    assert.deepEqual(flipped.map((c) => c.bookingContextId), [stranded.bookingContextId]);
    assert.equal(flipped[0].status, BookingContextStatus.VERIFICATION_REQUIRED);
    assert.equal(flipped[0].rejectionReason, 'stale_booking_in_progress');
    assert.equal((await store.get(fresh.bookingContextId)).status, BookingContextStatus.BOOKING_IN_PROGRESS);
    assert.equal((await store.get(untouched.bookingContextId)).status, BookingContextStatus.OFFERED);
  });

  test(`booking-context contract [${label}]: walk-in contexts (no sessionId) work end to end`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeContext({ sessionId: null });
    await store.create(input);
    const claimed = await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_B });
    assert.equal(claimed.sessionId, null);
    const booked = await store.complete({
      bookingContextId: input.bookingContextId, status: BookingContextStatus.BOOKED,
      calcomBookingUid: 'uid_walkin',
    });
    assert.equal(booked.status, BookingContextStatus.BOOKED);
  });

  // ── Native scheduling evolution (GitLab #80) ──────────────────────────────

  test(`booking-context contract [${label}]: native contexts round-trip provider, targets, and event id`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const input = makeNativeContext();
    const created = await store.create(input);
    assert.equal(created.eventTypeId, null);
    assert.equal(created.providerKey, 'reference');
    assert.equal(created.providerEventId, null);
    assert.deepEqual(created.offeredTargets, input.offeredTargets);

    const claimed = await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A });
    assert.equal(claimed.calendarRef, input.offeredTargets[SLOT_A].calendarRef,
      'the claim binds the offered target for the selected start');
    const booked = await store.complete({
      bookingContextId: input.bookingContextId, status: BookingContextStatus.BOOKED,
      providerEventId: 'evt-123', bookingResult: { providerEventId: 'evt-123', startsAt: SLOT_A, status: 'confirmed' },
    });
    assert.equal(booked.providerEventId, 'evt-123');
    assert.equal(booked.calcomBookingUid, null);
  });

  test(`booking-context contract [${label}]: a native context without complete targets is refused`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    await assert.rejects(
      store.create(makeNativeContext({ offeredTargets: { [SLOT_A]: { attorneyId: null, calendarRef: 'cal-x' } } })),
      /missing a calendar target/,
    );
    await assert.rejects(
      store.create(makeContext({ eventTypeId: null })),
      /eventTypeId or a native providerKey/,
    );
  });

  test(`booking-context contract [${label}]: the slot guard — one live claim per calendar+instant; the loser stays OFFERED`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const winner = makeNativeContext();
    const loser = makeNativeContext();
    const otherTenant = makeNativeContext({ organizationKey: 'org-b' });
    await store.create(winner);
    await store.create(loser);
    await store.create(otherTenant);

    assert.ok(await store.claim({ bookingContextId: winner.bookingContextId, startsAt: SLOT_A }));
    // Same organization, same calendar, same instant: refused, unconsumed.
    assert.equal(await store.claim({ bookingContextId: loser.bookingContextId, startsAt: SLOT_A }), null);
    assert.equal((await store.get(loser.bookingContextId)).status, BookingContextStatus.OFFERED,
      'the refused claim does NOT consume the context');
    // The loser can still claim its OTHER offered slot.
    assert.ok(await store.claim({ bookingContextId: loser.bookingContextId, startsAt: SLOT_B }));
    // A different organization never contends (tenant-scoped guard).
    assert.ok(await store.claim({ bookingContextId: otherTenant.bookingContextId, startsAt: SLOT_A }));
  });

  test(`booking-context contract [${label}]: a BOOKED slot stays guarded; terminal rejections release it`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const first = makeNativeContext();
    await store.create(first);
    await store.claim({ bookingContextId: first.bookingContextId, startsAt: SLOT_A });
    await store.complete({
      bookingContextId: first.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-1',
    });
    const second = makeNativeContext();
    await store.create(second);
    assert.equal(await store.claim({ bookingContextId: second.bookingContextId, startsAt: SLOT_A }), null,
      'booked occupies the slot');

    const rejectedFirst = makeNativeContext({
      offeredTargets: { [SLOT_A]: { attorneyId: 'clay-martinson', calendarRef: 'cal-released' }, [SLOT_B]: { attorneyId: 'clay-martinson', calendarRef: 'cal-released' } },
    });
    await store.create(rejectedFirst);
    await store.claim({ bookingContextId: rejectedFirst.bookingContextId, startsAt: SLOT_A });
    await store.complete({
      bookingContextId: rejectedFirst.bookingContextId, status: BookingContextStatus.REJECTED,
      rejectionReason: 'provider_rejected_400',
    });
    const retry = makeNativeContext({
      offeredTargets: { [SLOT_A]: { attorneyId: 'clay-martinson', calendarRef: 'cal-released' }, [SLOT_B]: { attorneyId: 'clay-martinson', calendarRef: 'cal-released' } },
    });
    await store.create(retry);
    assert.ok(await store.claim({ bookingContextId: retry.bookingContextId, startsAt: SLOT_A }),
      'a rejected booking releases the slot for a fresh context');
  });

  test(`booking-context contract [${label}]: every transition writes exactly one audit record`, async () => {
    const clock = fixedClock(T0);
    const audit = createInMemoryAuditLog();
    const store = await makeStore({ clock, audit });
    const input = makeNativeContext();
    await store.create(input);
    await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A });
    await store.complete({
      bookingContextId: input.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-a',
    });
    const trail = await audit.listByContext(input.bookingContextId);
    assert.deepEqual(trail.map((r) => [r.action, r.actor]), [
      ['created', 'caller-flow'], ['claimed', 'caller-flow'], ['booked', 'caller-flow'],
    ]);

    const stranded = makeNativeContext();
    await store.create(stranded);
    await store.claim({ bookingContextId: stranded.bookingContextId, startsAt: SLOT_B });
    clock.advance(STALE_BOOKING_MS + 1);
    await store.reconcileStale({});
    const strandedTrail = await audit.listByContext(stranded.bookingContextId);
    assert.deepEqual(strandedTrail.at(-1) && [strandedTrail.at(-1).action, strandedTrail.at(-1).actor],
      ['verification_required', 'reconciler']);
  });

  test(`booking-context contract [${label}]: cancellation lifecycle — booked -> pending -> cancelled, slot held then released`, async () => {
    const clock = fixedClock(T0);
    const audit = createInMemoryAuditLog();
    const store = await makeStore({ clock, audit });
    const booked = makeNativeContext();
    await store.create(booked);
    await store.claim({ bookingContextId: booked.bookingContextId, startsAt: SLOT_A });
    await store.complete({ bookingContextId: booked.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-c1' });

    // Only booked rows can begin cancellation.
    const offeredOnly = makeNativeContext();
    await store.create(offeredOnly);
    assert.equal(await store.beginCancellation({ bookingContextId: offeredOnly.bookingContextId }), null);

    const pending = await store.beginCancellation({ bookingContextId: booked.bookingContextId, actor: 'operator' });
    assert.equal(pending.status, BookingContextStatus.CANCELLATION_PENDING);
    // A pending cancellation still OCCUPIES the slot: the event exists
    // until the provider confirms.
    const contender = makeNativeContext();
    await store.create(contender);
    assert.equal(await store.claim({ bookingContextId: contender.bookingContextId, startsAt: SLOT_A }), null,
      'cancellation_pending still guards the calendar instant');

    const done = await store.completeCancellation({
      bookingContextId: booked.bookingContextId, status: BookingContextStatus.CANCELLED, actor: 'operator',
    });
    assert.equal(done.status, BookingContextStatus.CANCELLED);
    // Cancelled releases the slot.
    assert.ok(await store.claim({ bookingContextId: contender.bookingContextId, startsAt: SLOT_A }));

    const trail = await audit.listByContext(booked.bookingContextId);
    assert.deepEqual(trail.map((r) => [r.action, r.actor]).slice(-2),
      [['cancellation_pending', 'operator'], ['cancelled', 'operator']]);
  });

  test(`booking-context contract [${label}]: a definitive cancel refusal REVERTS to booked; concurrent cancels have one winner`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const booked = makeNativeContext();
    await store.create(booked);
    await store.claim({ bookingContextId: booked.bookingContextId, startsAt: SLOT_A });
    await store.complete({ bookingContextId: booked.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-c2' });

    const [a, b] = await Promise.all([
      store.beginCancellation({ bookingContextId: booked.bookingContextId }),
      store.beginCancellation({ bookingContextId: booked.bookingContextId }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, 'exactly one concurrent cancel proceeds');

    const reverted = await store.completeCancellation({
      bookingContextId: booked.bookingContextId, status: BookingContextStatus.BOOKED,
      rejectionReason: 'cancel_rejected_provider_rejected_400',
    });
    assert.equal(reverted.status, BookingContextStatus.BOOKED, 'the appointment still stands');
    // And it can be cancelled again later.
    assert.ok(await store.beginCancellation({ bookingContextId: booked.bookingContextId }));
  });

  test(`booking-context contract [${label}]: a stranded cancellation_pending reconciles to verification_required`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const booked = makeNativeContext();
    await store.create(booked);
    await store.claim({ bookingContextId: booked.bookingContextId, startsAt: SLOT_A });
    await store.complete({ bookingContextId: booked.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-c3' });
    await store.beginCancellation({ bookingContextId: booked.bookingContextId });
    clock.advance(STALE_BOOKING_MS + 1);
    const flipped = await store.reconcileStale({});
    assert.equal(flipped.length, 1);
    assert.equal(flipped[0].status, BookingContextStatus.VERIFICATION_REQUIRED);
    assert.equal(flipped[0].rejectionReason, 'stale_cancellation_pending');
  });

  test(`booking-context contract [${label}]: reschedule lifecycle — old slot held during the move, lineage recorded, revert works`, async () => {
    const clock = fixedClock(T0);
    const audit = createInMemoryAuditLog();
    const store = await makeStore({ clock, audit });
    const original = makeNativeContext();
    await store.create(original);
    await store.claim({ bookingContextId: original.bookingContextId, startsAt: SLOT_A });
    await store.complete({ bookingContextId: original.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-r1' });

    // The successor context records its lineage.
    const successor = makeNativeContext({ rescheduleOf: original.bookingContextId });
    const createdSuccessor = await store.create(successor);
    assert.equal(createdSuccessor.rescheduleOf, original.bookingContextId);

    // Only booked rows can begin a reschedule.
    assert.equal(await store.beginReschedule({ bookingContextId: successor.bookingContextId }), null);
    const begun = await store.beginReschedule({ bookingContextId: original.bookingContextId });
    assert.equal(begun.status, BookingContextStatus.RESCHEDULING);

    // 'rescheduling' still occupies the OLD instant.
    const contender = makeNativeContext();
    await store.create(contender);
    assert.equal(await store.claim({ bookingContextId: contender.bookingContextId, startsAt: SLOT_A }), null,
      'rescheduling still guards the original instant');

    // A definitive refusal REVERTS to booked…
    const reverted = await store.completeReschedule({
      bookingContextId: original.bookingContextId, status: BookingContextStatus.BOOKED,
      rejectionReason: 'reschedule_rejected_provider_rejected_400',
    });
    assert.equal(reverted.status, BookingContextStatus.BOOKED);
    // …and a later successful move terminates the original as rescheduled,
    // releasing the old instant.
    await store.beginReschedule({ bookingContextId: original.bookingContextId });
    const done = await store.completeReschedule({
      bookingContextId: original.bookingContextId, status: BookingContextStatus.RESCHEDULED,
    });
    assert.equal(done.status, BookingContextStatus.RESCHEDULED);
    assert.ok(await store.claim({ bookingContextId: contender.bookingContextId, startsAt: SLOT_A }),
      'a rescheduled original releases its old instant');
  });

  test(`booking-context contract [${label}]: a stranded rescheduling row reconciles to verification_required`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const original = makeNativeContext();
    await store.create(original);
    await store.claim({ bookingContextId: original.bookingContextId, startsAt: SLOT_A });
    await store.complete({ bookingContextId: original.bookingContextId, status: BookingContextStatus.BOOKED, providerEventId: 'evt-r2' });
    await store.beginReschedule({ bookingContextId: original.bookingContextId });
    clock.advance(STALE_BOOKING_MS + 1);
    const flipped = await store.reconcileStale({});
    assert.equal(flipped.length, 1);
    assert.equal(flipped[0].rejectionReason, 'stale_rescheduling');
  });

  test(`booking-context contract [${label}]: a THROWING audit sink never fails a transition`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({
      clock,
      audit: { async record() { throw new Error('audit sink down'); } },
    });
    const input = makeNativeContext();
    await store.create(input);
    const claimed = await store.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A });
    assert.ok(claimed, 'the transition succeeds despite the failing sink');
  });
}

module.exports = { runBookingContextContractSuite, makeContext, makeNativeContext, hash, T0, TTL_MS, SLOT_A, SLOT_B };
