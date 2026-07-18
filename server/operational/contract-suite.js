'use strict';

/**
 * Shared Handoff repository contract suite (ADR-0006).
 *
 * Every behavioral guarantee of the Handoff state machine, expressed against
 * the repository CONTRACT rather than an implementation — the same suite
 * runs against the in-memory reference store and the PostgreSQL store, so
 * the two can never drift apart silently.
 *
 * All data is synthetic. All time comes from the injected fixed clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { fixedClock } = require('../handoff/clock');
const { SessionStatus } = require('../handoff/status');
const { STALE_CLAIM_MS } = require('../handoff/store');
const { normalizePhone } = require('../handoff/phone');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const TTL_MS = 600 * 1000;

function hash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A synthetic InternalSession in awaiting-transfer state. */
function makeSession({ firmId = 'org-a', now = T0, phone = '+15550100' } = {}) {
  const suffix = crypto.randomUUID();
  return {
    session: {
      sessionId: crypto.randomUUID(),
      firmId,
      caller: { fullName: 'Test Caller', email: 'caller@example.com', phone },
      callerPhoneNormalized: normalizePhone(phone),
      scheduling: { attorneyId: 'att-1', practiceAreaId: 'area-1', consultationTypeId: 'type-1' },
      handoff: { createdByUserId: null, source: 'contract-test', mode: 'live-transfer' },
      status: SessionStatus.AWAITING_TRANSFER,
      tokenHash: hash(`handoff-${suffix}`),
      consoleTokenHash: hash(`console-${suffix}`),
      redeemedAtMs: null,
      cancelledAtMs: null,
      completedAtMs: null,
      outcome: null,
      summaryDelivery: null,
      summaryClaimedAtMs: null,
      createdAtMs: now,
      expiresAtMs: now + TTL_MS,
    },
    consoleTokenHash: hash(`console-${suffix}`),
  };
}

const BOOKED_OUTCOME = Object.freeze({
  status: 'booked',
  appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
  schedulingSummary: 'Initial consultation booked.',
});

/**
 * Register the contract tests for one repository implementation.
 * @param {string} label suite label, e.g. 'memory' or 'postgres'
 * @param {(deps: {clock: ReturnType<typeof fixedClock>}) => Promise<object>} makeStore
 *        fresh, EMPTY store per call
 */
function runHandoffRepositoryContractSuite(label, makeStore) {
  const t = (name, fn) => test(`[${label}] ${name}`, fn);

  t('create + get roundtrip; unknown id is undefined', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);

    const loaded = await store.get(session.sessionId);
    assert.equal(loaded.sessionId, session.sessionId);
    assert.equal(loaded.firmId, 'org-a');
    assert.equal(loaded.status, SessionStatus.AWAITING_TRANSFER);
    assert.equal(loaded.caller.fullName, 'Test Caller');
    assert.equal(loaded.caller.email, 'caller@example.com');
    assert.equal(loaded.callerPhoneNormalized, '+15550100', 'normalized phone persists');
    assert.equal(loaded.scheduling.consultationTypeId, 'type-1');
    assert.equal(loaded.tokenHash, session.tokenHash);
    assert.equal(loaded.outcome, null);
    assert.equal(loaded.summaryDelivery, null);
    assert.equal(loaded.createdAtMs, T0);
    assert.equal(loaded.expiresAtMs, T0 + TTL_MS);
    assert.equal(await store.get('no-such-session'), undefined);
    assert.equal(await store.size(), 1);
  });

  t('redeem: success connects; unknown 404; second attempt 409', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);

    const redeemed = await store.redeem(session.tokenHash);
    assert.equal(redeemed.status, SessionStatus.CONNECTED);
    assert.equal(redeemed.redeemedAtMs, T0);

    await assert.rejects(() => store.redeem(hash('nope')), (e) => e.status === 404 && e.code === 'unknown_token');
    await assert.rejects(() => store.redeem(session.tokenHash), (e) => e.status === 409 && e.code === 'token_already_redeemed');
  });

  t('redeem: cancelled wins over expiry (410 token_cancelled)', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session, consoleTokenHash } = makeSession();
    await store.create(session);
    await store.cancel(session.sessionId, consoleTokenHash);

    clock.set(T0 + TTL_MS + 60_000); // long past expiry
    await assert.rejects(() => store.redeem(session.tokenHash), (e) => e.status === 410 && e.code === 'token_cancelled');
  });

  t('redeem: valid until the last ms; 410 token_expired at expiry; get() shows expired', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession();
    const b = makeSession();
    await store.create(a.session);
    await store.create(b.session);

    clock.set(T0 + TTL_MS - 1);
    assert.equal((await store.redeem(a.session.tokenHash)).status, SessionStatus.CONNECTED);

    clock.set(T0 + TTL_MS);
    await assert.rejects(() => store.redeem(b.session.tokenHash), (e) => e.status === 410 && e.code === 'token_expired');
    assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.EXPIRED);
  });

  t('statusByConsole: wrong hash 403; unknown 404; lazy expiry applies', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session, consoleTokenHash } = makeSession();
    await store.create(session);

    await assert.rejects(() => store.statusByConsole(session.sessionId, hash('wrong')), (e) => e.status === 403);
    await assert.rejects(() => store.statusByConsole('missing', consoleTokenHash), (e) => e.status === 404);

    clock.set(T0 + TTL_MS);
    const expired = await store.statusByConsole(session.sessionId, consoleTokenHash);
    assert.equal(expired.status, SessionStatus.EXPIRED);
  });

  t('cancel matrix: cancels; idempotent repeat; 410 post-expiry repeat; 409 connected; 410 expired', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });

    const a = makeSession();
    await store.create(a.session);
    const cancelled = await store.cancel(a.session.sessionId, a.consoleTokenHash);
    assert.equal(cancelled.status, SessionStatus.CANCELLED);
    assert.equal(cancelled.cancelledAtMs, T0);
    assert.equal((await store.cancel(a.session.sessionId, a.consoleTokenHash)).status, SessionStatus.CANCELLED, 'idempotent repeat');
    clock.set(T0 + TTL_MS);
    await assert.rejects(() => store.cancel(a.session.sessionId, a.consoleTokenHash), (e) => e.status === 410 && e.code === 'session_expired');

    clock.set(T0);
    const b = makeSession();
    await store.create(b.session);
    await store.redeem(b.session.tokenHash);
    await assert.rejects(() => store.cancel(b.session.sessionId, b.consoleTokenHash), (e) => e.status === 409 && e.code === 'cannot_cancel');

    const c = makeSession();
    await store.create(c.session);
    clock.set(T0 + TTL_MS);
    await assert.rejects(() => store.cancel(c.session.sessionId, c.consoleTokenHash), (e) => e.status === 410 && e.code === 'session_expired');
  });

  t('connectDemo: 404 empty; connects exactly-one; 409 when two (neither redeemed); expired not eligible', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });

    await assert.rejects(() => store.connectDemo('org-a'), (e) => e.status === 404 && e.code === 'no_prepared_session');

    const a = makeSession();
    await store.create(a.session);
    const connected = await store.connectDemo('org-a');
    assert.equal(connected.sessionId, a.session.sessionId);
    assert.equal(connected.status, SessionStatus.CONNECTED);

    const b = makeSession();
    const c = makeSession();
    await store.create(b.session);
    await store.create(c.session);
    await assert.rejects(() => store.connectDemo('org-a'), (e) => e.status === 409 && e.code === 'ambiguous_prepared_sessions');
    assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'ambiguity redeems neither');
    assert.equal((await store.get(c.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'ambiguity redeems neither');

    clock.set(T0 + TTL_MS);
    await assert.rejects(() => store.connectDemo('org-a'), (e) => e.status === 404, 'expired sessions are not eligible');
  });

  t('tenant isolation: connectDemo never crosses organizations', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession({ firmId: 'org-a' });
    const b = makeSession({ firmId: 'org-b', phone: '+15550100' }); // same phone, different tenant
    await store.create(a.session);
    await store.create(b.session);

    const connected = await store.connectDemo('org-a');
    assert.equal(connected.sessionId, a.session.sessionId);
    assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'other tenant untouched');
    const other = await store.connectDemo('org-b');
    assert.equal(other.sessionId, b.session.sessionId);
  });

  // ── connectEligible: the Correlation Engine's storage primitive ──────────

  t('connectEligible: empty criteria is the exactly-one-eligible baseline (404 / connect / 409)', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });

    await assert.rejects(() => store.connectEligible('org-a', {}), (e) => e.status === 404 && e.code === 'no_prepared_session');

    const a = makeSession();
    await store.create(a.session);
    const connected = await store.connectEligible('org-a', {});
    assert.equal(connected.sessionId, a.session.sessionId);
    assert.equal(connected.status, SessionStatus.CONNECTED);

    const b = makeSession();
    const c = makeSession();
    await store.create(b.session);
    await store.create(c.session);
    await assert.rejects(() => store.connectEligible('org-a', {}), (e) => e.status === 409 && e.code === 'ambiguous_prepared_sessions');
    assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'ambiguity redeems neither');
    assert.equal((await store.get(c.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'ambiguity redeems neither');
  });

  t('connectEligible by session id: addresses one session among many; unknown/ineligible ids match nothing', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession({ phone: '+15550101' });
    const b = makeSession({ phone: '+15550102' });
    const c = makeSession({ phone: '+15550103' });
    for (const s of [a, b, c]) await store.create(s.session);

    const connected = await store.connectEligible('org-a', { sessionId: b.session.sessionId });
    assert.equal(connected.sessionId, b.session.sessionId);
    assert.equal((await store.get(a.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'others untouched');
    assert.equal((await store.get(c.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'others untouched');

    await assert.rejects(() => store.connectEligible('org-a', { sessionId: 'no-such-session' }), (e) => e.code === 'no_prepared_session');
    await assert.rejects(() => store.connectEligible('org-a', { sessionId: b.session.sessionId }), (e) => e.code === 'no_prepared_session', 'a connected session is no longer eligible');
  });

  t('connectEligible by session id never crosses organizations', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const other = makeSession({ firmId: 'org-b' });
    await store.create(other.session);

    await assert.rejects(
      () => store.connectEligible('org-a', { sessionId: other.session.sessionId }),
      (e) => e.code === 'no_prepared_session',
      'another tenant\'s session id matches nothing',
    );
    assert.equal((await store.get(other.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);
  });

  t('connectEligible by phone: exactly-one match connects; zero matches 404; duplicates are ambiguous and redeem none', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession({ phone: '+15550101' });
    const b = makeSession({ phone: '+15550102' });
    const c = makeSession({ phone: null }); // prepared without a phone
    for (const s of [a, b, c]) await store.create(s.session);

    const connected = await store.connectEligible('org-a', { callerPhoneNormalized: '+15550102' });
    assert.equal(connected.sessionId, b.session.sessionId);
    assert.equal((await store.get(a.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);

    await assert.rejects(() => store.connectEligible('org-a', { callerPhoneNormalized: '+15559999' }), (e) => e.code === 'no_prepared_session');

    const d = makeSession({ phone: '+15550104' });
    const e2 = makeSession({ phone: '+15550104' }); // duplicate within the org
    await store.create(d.session);
    await store.create(e2.session);
    await assert.rejects(() => store.connectEligible('org-a', { callerPhoneNormalized: '+15550104' }), (e) => e.status === 409 && e.code === 'ambiguous_prepared_sessions');
    assert.equal((await store.get(d.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'ambiguity redeems neither');
    assert.equal((await store.get(e2.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'ambiguity redeems neither');
  });

  t('connectEligible by phone never crosses organizations — duplicate numbers across tenants stay isolated', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession({ firmId: 'org-a', phone: '+15550100' });
    const b = makeSession({ firmId: 'org-b', phone: '+15550100' }); // same number, different tenant
    await store.create(a.session);
    await store.create(b.session);

    const inA = await store.connectEligible('org-a', { callerPhoneNormalized: '+15550100' });
    assert.equal(inA.sessionId, a.session.sessionId, 'no cross-tenant ambiguity');
    assert.equal((await store.get(b.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'other tenant untouched');
    const inB = await store.connectEligible('org-b', { callerPhoneNormalized: '+15550100' });
    assert.equal(inB.sessionId, b.session.sessionId);
  });

  t('connectEligible: expired sessions are never correlation candidates', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession({ phone: '+15550105' });
    await store.create(session);

    clock.set(T0 + TTL_MS);
    await assert.rejects(() => store.connectEligible('org-a', { callerPhoneNormalized: '+15550105' }), (e) => e.code === 'no_prepared_session');
    assert.equal((await store.get(session.sessionId)).status, SessionStatus.EXPIRED);
  });

  t('connectEligible: unknown criteria keys are rejected loudly, never silently ignored', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);

    await assert.rejects(
      () => store.connectEligible('org-a', { queueId: 'q-1' }),
      (e) => e instanceof TypeError && /queueId/.test(e.message),
    );
    assert.equal((await store.get(session.sessionId)).status, SessionStatus.AWAITING_TRANSFER, 'nothing redeemed');
  });

  t('concurrent connectEligible: distinct phones connect in parallel to their own sessions', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession({ phone: '+15550111' });
    const b = makeSession({ phone: '+15550112' });
    await store.create(a.session);
    await store.create(b.session);

    const [ra, rb] = await Promise.all([
      store.connectEligible('org-a', { callerPhoneNormalized: '+15550111' }),
      store.connectEligible('org-a', { callerPhoneNormalized: '+15550112' }),
    ]);
    assert.equal(ra.sessionId, a.session.sessionId);
    assert.equal(rb.sessionId, b.session.sessionId);
    assert.equal(ra.status, SessionStatus.CONNECTED);
    assert.equal(rb.status, SessionStatus.CONNECTED);
  });

  t('concurrent connectEligible on the same phone: exactly one winner', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession({ phone: '+15550113' });
    await store.create(session);

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => store.connectEligible('org-a', { callerPhoneNormalized: '+15550113' })),
    );
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await store.get(session.sessionId)).status, SessionStatus.CONNECTED);
  });

  t('create with a prepared-session cap: 429 at capacity, nothing inserted; transitions free capacity; other organizations unaffected', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const cap = { maxEligiblePrepared: 2 };

    const a = makeSession({ phone: '+15550101' });
    const b = makeSession({ phone: '+15550102' });
    await store.create(a.session, cap);
    await store.create(b.session, cap);

    const c = makeSession({ phone: '+15550103' });
    await assert.rejects(() => store.create(c.session, cap), (e) => e.status === 429 && e.code === 'too_many_prepared_sessions');
    assert.equal(await store.get(c.session.sessionId), undefined, 'a rejected create inserts nothing');
    assert.equal(await store.countEligible('org-a'), 2);

    // Another organization has independent capacity.
    const other = makeSession({ firmId: 'org-b' });
    await store.create(other.session, cap);

    // Cancellation frees capacity.
    await store.cancel(a.session.sessionId, a.consoleTokenHash);
    await store.create(makeSession({ phone: '+15550104' }).session, cap);

    // Connection frees capacity (connected sessions are not "prepared").
    await store.connectEligible('org-a', { callerPhoneNormalized: '+15550102' });
    await store.create(makeSession({ phone: '+15550105' }).session, cap);

    // Expiry frees capacity.
    clock.set(T0 + TTL_MS);
    const late = makeSession({ now: T0 + TTL_MS, phone: '+15550106' });
    await store.create(late.session, cap);
    assert.equal(await store.countEligible('org-a'), 1);

    // An uncapped create (no option) is unaffected — e.g. contract fixtures.
    const uncapped = makeSession({ now: T0 + TTL_MS, phone: '+15550107' });
    await store.create(uncapped.session);
    const uncapped2 = makeSession({ now: T0 + TTL_MS, phone: '+15550108' });
    await store.create(uncapped2.session);
  });

  t('concurrent capped creates never overshoot the cap: exactly cap successes, the rest 429', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const CAP = 3;

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => store.create(
        makeSession({ phone: `+1555020${i}` }).session,
        { maxEligiblePrepared: CAP },
      )),
    );
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, CAP, 'exactly cap creations succeed');
    assert.equal(
      attempts.filter((r) => r.status === 'rejected' && r.reason.status === 429 && r.reason.code === 'too_many_prepared_sessions').length,
      10 - CAP,
      'every other request is a clean 429',
    );
    assert.equal(await store.countEligible('org-a'), CAP, 'the store holds exactly cap eligible sessions');
  });

  t('countEligible: counts unexpired awaiting-transfer sessions per organization; expiry and transitions drop the count', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    assert.equal(await store.countEligible('org-a'), 0);

    const a = makeSession({ phone: '+15550101' });
    const b = makeSession({ phone: '+15550102' });
    const other = makeSession({ firmId: 'org-b' });
    for (const s of [a, b, other]) await store.create(s.session);
    assert.equal(await store.countEligible('org-a'), 2, 'organization-scoped');
    assert.equal(await store.countEligible('org-b'), 1);

    await store.cancel(a.session.sessionId, a.consoleTokenHash);
    assert.equal(await store.countEligible('org-a'), 1, 'cancelled sessions do not count');

    clock.set(T0 + TTL_MS);
    assert.equal(await store.countEligible('org-a'), 0, 'expired sessions do not count');
  });

  t('concurrent redeem: exactly one success', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => store.redeem(session.tokenHash)),
    );
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 9);
  });

  t('concurrent connectDemo: exactly one success', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => store.connectDemo('org-a')),
    );
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await store.get(session.sessionId)).status, SessionStatus.CONNECTED);
  });

  t('cancel vs redeem race: exactly one winner, consistent final state', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session, consoleTokenHash } = makeSession();
    await store.create(session);

    const [cancelResult, redeemResult] = await Promise.allSettled([
      store.cancel(session.sessionId, consoleTokenHash),
      store.redeem(session.tokenHash),
    ]);
    const winners = [cancelResult, redeemResult].filter((r) => r.status === 'fulfilled');
    assert.equal(winners.length, 1, 'exactly one of cancel/redeem wins');
    const finalStatus = (await store.get(session.sessionId)).status;
    if (cancelResult.status === 'fulfilled') {
      assert.equal(finalStatus, SessionStatus.CANCELLED);
      assert.equal(redeemResult.reason.code, 'token_cancelled');
    } else {
      assert.equal(finalStatus, SessionStatus.CONNECTED);
      assert.equal(cancelResult.reason.code, 'cannot_cancel');
    }
  });

  t('outcome: first terminal wins; identical duplicate idempotent; conflict rejected without mutation', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);
    await store.redeem(session.tokenHash);

    clock.set(T0 + 60_000);
    const first = await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME });
    assert.equal(first.duplicate, false);
    assert.equal(first.session.status, 'booked');
    assert.equal(first.session.completedAtMs, T0 + 60_000);

    const dup = await store.applyOutcome(session.sessionId, JSON.parse(JSON.stringify(BOOKED_OUTCOME)));
    assert.equal(dup.duplicate, true);
    assert.equal(dup.session.completedAtMs, T0 + 60_000, 'duplicate does not touch the record');

    await assert.rejects(
      () => store.applyOutcome(session.sessionId, { status: 'failed', schedulingSummary: 'No.' }),
      (e) => e.status === 409 && e.code === 'outcome_conflict',
    );
    const after = await store.get(session.sessionId);
    assert.equal(after.status, 'booked', 'conflict never mutates');
    assert.deepEqual(after.outcome, BOOKED_OUTCOME);
  });

  t('outcome: invalid states reject without mutation (awaiting, cancelled, unknown)', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const a = makeSession();
    await store.create(a.session);
    await assert.rejects(
      () => store.applyOutcome(a.session.sessionId, { ...BOOKED_OUTCOME }),
      (e) => e.status === 409 && e.code === 'invalid_outcome_state',
    );
    assert.equal((await store.get(a.session.sessionId)).status, SessionStatus.AWAITING_TRANSFER);

    await store.cancel(a.session.sessionId, a.consoleTokenHash);
    await assert.rejects(
      () => store.applyOutcome(a.session.sessionId, { ...BOOKED_OUTCOME }),
      (e) => e.status === 409 && e.code === 'invalid_outcome_state',
    );
    await assert.rejects(
      () => store.applyOutcome('missing', { ...BOOKED_OUTCOME }),
      (e) => e.status === 404 && e.code === 'unknown_session',
    );
  });

  t('delivery claim: exactly one concurrent claimant; failed permits retry; sent is final', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);
    await store.redeem(session.tokenHash);
    await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME });

    const claims = await Promise.all(
      Array.from({ length: 6 }, () => store.claimSummaryDelivery(session.sessionId)),
    );
    assert.equal(claims.filter((c) => c.claimed).length, 1, 'exactly one concurrent claim');

    await store.recordSummaryDelivery(session.sessionId, 'failed');
    const retry = await store.claimSummaryDelivery(session.sessionId);
    assert.equal(retry.claimed, true, 'failed permits retry');

    await store.recordSummaryDelivery(session.sessionId, 'sent');
    clock.set(T0 + STALE_CLAIM_MS * 10); // even far in the future
    const afterSent = await store.claimSummaryDelivery(session.sessionId);
    assert.equal(afterSent.claimed, false, 'sent is never re-claimed');
    assert.equal(afterSent.summaryDelivery, 'sent');
  });

  t('delivery claim: an abandoned pending claim is re-claimable after the stale window', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);
    await store.redeem(session.tokenHash);
    await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME });

    assert.equal((await store.claimSummaryDelivery(session.sessionId)).claimed, true);
    // Claimant "crashes": no recordSummaryDelivery follows.
    clock.set(T0 + STALE_CLAIM_MS - 1);
    assert.equal((await store.claimSummaryDelivery(session.sessionId)).claimed, false, 'fresh pending blocks');
    clock.set(T0 + STALE_CLAIM_MS);
    assert.equal((await store.claimSummaryDelivery(session.sessionId)).claimed, true, 'stale pending re-claimable');
  });

  t('latestCompleted: undefined when none; newest completion wins; organization-scoped', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    assert.equal(await store.latestCompleted('org-a'), undefined);

    const first = makeSession();
    await store.create(first.session);
    await store.connectDemo('org-a');
    await store.applyOutcome(first.session.sessionId, { status: 'failed', schedulingSummary: 'No time.' });

    clock.set(T0 + 120_000);
    const second = makeSession({ now: T0 + 120_000 });
    await store.create(second.session);
    await store.connectDemo('org-a');
    await store.applyOutcome(second.session.sessionId, { ...BOOKED_OUTCOME });

    assert.equal((await store.latestCompleted('org-a')).sessionId, second.session.sessionId);
    assert.equal(await store.latestCompleted('org-b'), undefined, 'other tenants see nothing');
  });

  t('storage holds hashes only — never raw token material', async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const { session } = makeSession();
    await store.create(session);
    const loaded = await store.get(session.sessionId);
    const flat = JSON.stringify(loaded);
    assert.equal(/gh_handoff_|gh_console_/.test(flat), false, 'no raw token prefixes anywhere');
    assert.match(loaded.tokenHash, /^[0-9a-f]{64}$/);
    assert.match(loaded.consoleTokenHash, /^[0-9a-f]{64}$/);
  });
}

module.exports = { runHandoffRepositoryContractSuite, makeSession, BOOKED_OUTCOME, hash };
