'use strict';

/**
 * Shared Integration delivery-store contract suite (ADR-0020).
 *
 * Every guarantee of the delivery-idempotency claim machine, expressed
 * against the store CONTRACT rather than an implementation — the same
 * suite runs against the in-memory reference store and the PostgreSQL
 * store, so the two can never drift apart silently (the ADR-0006
 * contract-suite discipline).
 *
 * All data is synthetic. All time comes from the injected fixed clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { fixedClock } = require('../handoff/clock');
const { STALE_CLAIM_MS } = require('../handoff/store');

const T0 = Date.parse('2026-07-12T15:15:00Z');

/**
 * @param {string} label suite label ('memory' | 'postgres')
 * @param {(deps: { clock: import('../handoff/clock').Clock }) => Promise<object>} makeStore
 */
function runIntegrationDeliveryStoreContractSuite(label, makeStore) {
  const key = () => `demo-record-sync:${crypto.randomUUID()}`;

  test(`integration deliveries [${label}]: first claim wins; concurrent duplicate is refused`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const k = key();
    assert.deepEqual(await store.claim(k), { claimed: true, status: 'pending' });
    assert.deepEqual(await store.claim(k), { claimed: false, status: 'pending' });
    await store.close();
  });

  test(`integration deliveries [${label}]: 'completed' is final — never re-claimed`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const k = key();
    await store.claim(k);
    await store.record(k, 'completed');
    assert.deepEqual(await store.claim(k), { claimed: false, status: 'completed' });
    // Even far beyond the stale window, completed stays final.
    clock.set(T0 + STALE_CLAIM_MS * 10);
    assert.deepEqual(await store.claim(k), { claimed: false, status: 'completed' });
    assert.equal((await store.get(k)).status, 'completed');
    await store.close();
  });

  test(`integration deliveries [${label}]: 'failed' is re-claimable — recovery can retry`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const k = key();
    await store.claim(k);
    await store.record(k, 'failed');
    assert.deepEqual(await store.claim(k), { claimed: true, status: 'pending' });
    await store.record(k, 'completed');
    assert.equal((await store.get(k)).status, 'completed');
    await store.close();
  });

  test(`integration deliveries [${label}]: a stale 'pending' claim is recovered after the stale window`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const k = key();
    await store.claim(k); // claimant crashes mid-delivery
    clock.set(T0 + STALE_CLAIM_MS - 1);
    assert.equal((await store.claim(k)).claimed, false, 'not yet stale');
    clock.set(T0 + STALE_CLAIM_MS);
    assert.deepEqual(await store.claim(k), { claimed: true, status: 'pending' }, 'stale claim recovered exactly at the window');
    await store.close();
  });

  test(`integration deliveries [${label}]: 'not-configured' is a controlled recorded result`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const k = key();
    await store.claim(k);
    await store.record(k, 'not-configured');
    assert.equal((await store.get(k)).status, 'not-configured');
    await store.close();
  });

  test(`integration deliveries [${label}]: listRecent exposes keys and statuses only, newest first`, async () => {
    const clock = fixedClock(T0);
    const store = await makeStore({ clock });
    const first = key(); const second = key();
    await store.claim(first);
    await store.record(first, 'completed');
    clock.set(T0 + 1000);
    await store.claim(second);
    const recent = await store.listRecent({ limit: 10 });
    const keys = recent.map((r) => r.integrationKey);
    assert.ok(keys.indexOf(second) < keys.indexOf(first), 'newest first');
    for (const r of recent) {
      assert.deepEqual(Object.keys(r).sort(), ['claimedAtMs', 'integrationKey', 'status'],
        'no facts, payloads, or customer data in visibility records');
    }
    await store.close();
  });
}

module.exports = { runIntegrationDeliveryStoreContractSuite };
