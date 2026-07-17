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
