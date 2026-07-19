'use strict';

/**
 * The user-session lifecycle suite (ADR-0013 / #64), shared between store
 * implementations: the SAME assertions run against the in-memory reference
 * (identity/user-sessions.test.js) and the durable PostgreSQL store
 * (operational/operational.test.js, where every PostgreSQL leg lives so
 * parallel test files never share the database). A store passing this
 * suite preserves the full session contract: opaque prefixed tokens,
 * hash-keyed storage, frozen validated identity, ABSOLUTE lazy expiry,
 * immediate invalidation, login rotation (fixation protection), and
 * user-only sessions.
 */

const assert = require('node:assert/strict');

const { createUserSessionService, SESSION_TOKEN_PREFIX } = require('./user-sessions');
const { fixedClock } = require('../handoff/clock');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const CLAIM = Object.freeze({
  subject: 'jane-doe', type: 'user', displayName: 'Jane Doe',
  organizationKey: 'martinson-beason', roles: Object.freeze(['receptionist']),
});

/**
 * @param {string} label store name for test titles
 * @param {(deps: { clock: import('../handoff/clock').Clock }) => object|Promise<object>} makeStore
 *        fresh store per test (may share a database — tokens are unique)
 * @param {(name: string, fn: () => Promise<void>) => void} defineTest
 *        the host file's test registrar (so each file owns its runner)
 */
function runUserSessionLifecycleSuite(label, makeStore, defineTest) {
  defineTest(`[${label}] lifecycle: establish → validate round-trip; opaque token; frozen identity`, async () => {
    const clock = fixedClock(T0);
    const sessions = createUserSessionService({ store: await makeStore({ clock }), clock, ttlSeconds: 3600 });
    const { token, identity } = await sessions.establish(CLAIM, 'dev-user');

    assert.ok(token.startsWith(SESSION_TOKEN_PREFIX));
    assert.equal(identity.provider, 'dev-user', 'provenance stamped by the contract');

    const validated = await sessions.validate(token);
    assert.equal(validated.identity.subject, 'jane-doe');
    assert.deepEqual([...validated.identity.roles], ['receptionist']);
    assert.ok(Object.isFrozen(validated.identity), 'frozen identity survives the store round-trip');
    assert.ok(Object.isFrozen(validated.identity.roles), 'roles frozen too');

    assert.equal(await sessions.validate(SESSION_TOKEN_PREFIX + 'forged'), null, 'unknown tokens are null');
    assert.equal(await sessions.validate(undefined), null);
  });

  defineTest(`[${label}] lifecycle: expiry is ABSOLUTE and lazy — activity never extends it`, async () => {
    const clock = fixedClock(T0);
    const sessions = createUserSessionService({ store: await makeStore({ clock }), clock, ttlSeconds: 3600 });
    const { token } = await sessions.establish(CLAIM, 'dev-user');

    clock.set(T0 + 3600 * 1000 - 1);
    assert.ok(await sessions.validate(token), 'valid until the last ms — repeated validation does not slide it');
    clock.set(T0 + 3600 * 1000);
    assert.equal(await sessions.validate(token), null, 'dead exactly at the absolute TTL');
    clock.set(T0);
    assert.equal(await sessions.validate(token), null, 'lazy expiry removed the record — it cannot resurrect');
  });

  defineTest(`[${label}] lifecycle: logout invalidation is immediate; rotation kills the presented token (fixation)`, async () => {
    const clock = fixedClock(T0);
    const sessions = createUserSessionService({ store: await makeStore({ clock }), clock, ttlSeconds: 3600 });

    const first = await sessions.establish(CLAIM, 'dev-user');
    await sessions.invalidate(first.token);
    assert.equal(await sessions.validate(first.token), null, 'invalidated immediately');

    const second = await sessions.establish(CLAIM, 'dev-user');
    const third = await sessions.establish(CLAIM, 'dev-user', { presentedToken: second.token });
    assert.notEqual(third.token, second.token, 'login always issues a fresh token');
    assert.equal(await sessions.validate(second.token), null, 'a pre-login token cannot survive login');
    assert.ok(await sessions.validate(third.token));
  });

  defineTest(`[${label}] lifecycle: sessions are for USERS only`, async () => {
    const clock = fixedClock(T0);
    const sessions = createUserSessionService({ store: await makeStore({ clock }), clock, ttlSeconds: 3600 });
    await assert.rejects(
      () => sessions.establish({ ...CLAIM, type: 'service' }, 'dev-user'),
      (e) => e.status === 401,
    );
  });
}

module.exports = { runUserSessionLifecycleSuite, SUITE_CLAIM: CLAIM };
