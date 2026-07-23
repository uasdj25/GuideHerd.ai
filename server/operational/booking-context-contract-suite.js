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
const { BookingContextStatus, STALE_BOOKING_MS } = require('../scheduling/booking-context-store');

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
}

module.exports = { runBookingContextContractSuite, makeContext, hash, T0, TTL_MS, SLOT_A, SLOT_B };
