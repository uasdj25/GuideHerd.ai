'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./app');
const { fixedClock } = require('./clock');
const { SessionStatus } = require('./status');

const AT_1515 = Date.parse('2026-07-12T15:15:00Z');

function validRequest(overrides = {}) {
  return {
    firmId: 'martinson-beason',
    caller: { fullName: 'David Jones', phone: '+14044232676' },
    scheduling: {
      attorneyId: 'clay-martinson',
      practiceAreaId: 'personal-injury',
      consultationTypeId: 'initial-consultation',
      existingClient: false,
    },
    handoff: { createdByUserId: 'receptionist-001', source: 'receptionist-portal', mode: 'live-transfer' },
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------

test('valid handoff creates an awaiting-transfer session', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { response, handoffToken } = service.create(validRequest());

  assert.equal(response.status, SessionStatus.AWAITING_TRANSFER);
  assert.ok(response.sessionId, 'sessionId is present');
  assert.ok(handoffToken, 'handoffToken is present');
  assert.match(handoffToken, /^gh_handoff_/);
});

test('expiration is exactly ten minutes after creation, in UTC ISO-8601', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { response } = service.create(validRequest());

  assert.equal(response.createdAt, '2026-07-12T15:15:00.000Z');
  assert.equal(response.expiresAt, '2026-07-12T15:25:00.000Z');
  assert.equal(response.expiresInSeconds, 600);
});

test('optional fields may be omitted', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { handoffToken } = service.create({
    firmId: 'martinson-beason',
    caller: { fullName: 'Casey Vega' },
    scheduling: { attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  });
  const ctx = service.redeem(handoffToken);
  assert.equal(ctx.callerPhone, null);
  assert.equal(ctx.practiceAreaId, null);
  assert.equal(ctx.existingClient, false);
});

// --------------------------------------------------------------------------
// Redemption
// --------------------------------------------------------------------------

test('valid token redeems once and moves the session to connected', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { handoffToken } = service.create(validRequest());

  const ctx = service.redeem(handoffToken);
  assert.equal(ctx.status, SessionStatus.CONNECTED);
  assert.equal(ctx.callerName, 'David Jones');
  assert.equal(ctx.callerLastName, 'Jones');
  assert.equal(ctx.callerPhone, '+14044232676');
  assert.equal(ctx.attorneyId, 'clay-martinson');
  assert.equal(ctx.practiceAreaId, 'personal-injury');
  assert.equal(ctx.consultationTypeId, 'initial-consultation');
  assert.equal(ctx.existingClient, false);
});

test('redeem response contains only scheduling context (no receptionist or vendor fields)', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { handoffToken } = service.create(validRequest());
  const ctx = service.redeem(handoffToken);

  assert.deepEqual(
    Object.keys(ctx).sort(),
    ['attorneyId', 'callerLastName', 'callerName', 'callerPhone', 'consultationTypeId', 'existingClient', 'practiceAreaId', 'sessionId', 'status'].sort(),
  );
  // createdByUserId / source / mode must not leak.
  assert.equal('createdByUserId' in ctx, false);
  assert.equal('source' in ctx, false);
  assert.equal('mode' in ctx, false);
});

test('unknown token is rejected with 404', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  assert.throws(() => service.redeem('gh_handoff_nonexistent'), (e) => e.status === 404 && e.code === 'unknown_token');
});

test('a token cannot be redeemed twice (409 on second attempt)', () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { handoffToken } = service.create(validRequest());
  service.redeem(handoffToken);
  assert.throws(() => service.redeem(handoffToken), (e) => e.status === 409 && e.code === 'token_already_redeemed');
});

test('concurrent redemption attempts result in exactly one success', async () => {
  const { service } = createApp({ clock: fixedClock(AT_1515) });
  const { handoffToken } = service.create(validRequest());

  const attempts = await Promise.allSettled(
    Array.from({ length: 25 }, () => Promise.resolve().then(() => service.redeem(handoffToken))),
  );
  const succeeded = attempts.filter((a) => a.status === 'fulfilled');
  const conflicts = attempts.filter((a) => a.status === 'rejected' && a.reason.status === 409);

  assert.equal(succeeded.length, 1);
  assert.equal(conflicts.length, 24);
});

// --------------------------------------------------------------------------
// Expiration (deterministic via the fake clock — no sleeps)
// --------------------------------------------------------------------------

test('a token is valid right up until it expires', () => {
  const clock = fixedClock(AT_1515);
  const { service } = createApp({ clock });
  const { handoffToken } = service.create(validRequest());

  clock.set(Date.parse('2026-07-12T15:24:59Z')); // 1s before expiry
  const ctx = service.redeem(handoffToken);
  assert.equal(ctx.status, SessionStatus.CONNECTED);
});

test('a token is invalid at or after expiry, and no context is returned', () => {
  const clock = fixedClock(AT_1515);
  const { service } = createApp({ clock });
  const { handoffToken } = service.create(validRequest());

  clock.set(Date.parse('2026-07-12T15:25:00Z')); // exactly expiresAt
  assert.throws(() => service.redeem(handoffToken), (e) => e.status === 410 && e.code === 'token_expired');
});

test('an expired session is marked expired when accessed', () => {
  const clock = fixedClock(AT_1515);
  const { service, store } = createApp({ clock });
  const { response } = service.create(validRequest());

  clock.set(Date.parse('2026-07-12T16:00:00Z'));
  const session = store.get(response.sessionId);
  assert.equal(session.status, SessionStatus.EXPIRED);
});
