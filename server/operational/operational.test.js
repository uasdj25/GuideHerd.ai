'use strict';

/**
 * Operational Store tests (ADR-0006).
 *
 * The shared repository contract suite always runs against the in-memory
 * reference implementation. When GUIDEHERD_TEST_DATABASE_URL points at a
 * disposable PostgreSQL database, the SAME suite runs against the durable
 * implementation, plus PostgreSQL-only tests: migration idempotency and
 * serialization, restart persistence, multi-instance concurrency (two app
 * instances sharing one database), fail-fast boot behavior, and persisted-row
 * scans. Without the variable, those tests are skipped and say so.
 *
 * All data is synthetic; no external provider is ever called.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createInMemoryHandoffStore } = require('../handoff/store');
const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { runHandoffRepositoryContractSuite, makeSession, BOOKED_OUTCOME } = require('./contract-suite');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const PG_URL = process.env.GUIDEHERD_TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Contract suite — in-memory reference implementation (always runs)
// ---------------------------------------------------------------------------

runHandoffRepositoryContractSuite('memory', async ({ clock }) => createInMemoryHandoffStore({ clock }));

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

if (!PG_URL) {
  test('postgres suite skipped — set GUIDEHERD_TEST_DATABASE_URL to run it', (t) => {
    t.skip('no PostgreSQL test database configured');
  });
} else {
  const { createOperationalPool } = require('./db');
  const { migrate } = require('./migrate');
  const { createPostgresHandoffStore } = require('./session-repository');

  /** One shared pool for the suite; contract stores share it (close unused). */
  let sharedPool;

  async function resetDatabase(pool) {
    await pool.query('DROP TABLE IF EXISTS outbox_deliveries');
    await pool.query('DROP TABLE IF EXISTS outbox_events');
    await pool.query('DROP TABLE IF EXISTS handoff_sessions');
    await pool.query('DROP TABLE IF EXISTS notification_deliveries');
    await pool.query('DROP TABLE IF EXISTS operational_schema_migrations');
  }

  test('[postgres] migrations: fresh apply, idempotent re-run, concurrent runners serialize', async () => {
    sharedPool = createOperationalPool({ connectionString: PG_URL });
    await resetDatabase(sharedPool);

    assert.equal(await migrate(sharedPool), 3, 'all pending migrations apply');
    assert.equal(await migrate(sharedPool), 0, 're-run is a no-op');

    // Concurrent boots: several runners at once, advisory lock serializes.
    await resetDatabase(sharedPool);
    const pools = [createOperationalPool({ connectionString: PG_URL }), createOperationalPool({ connectionString: PG_URL })];
    const results = await Promise.all([migrate(sharedPool), migrate(pools[0]), migrate(pools[1])]);
    assert.equal(results.reduce((a, b) => a + b, 0), 3, 'exactly one runner applies the migrations');
    await Promise.all(pools.map((p) => p.end()));

    const { rows } = await sharedPool.query('SELECT count(*)::int AS n FROM operational_schema_migrations');
    assert.equal(rows[0].n, 3);
  });

  // Contract suite against PostgreSQL. Each test gets a truncated table on
  // the shared pool — same database, clean state, migrations already applied.
  runHandoffRepositoryContractSuite('postgres', async ({ clock }) => {
    await sharedPool.query('TRUNCATE handoff_sessions');
    const store = createPostgresHandoffStore({ pool: sharedPool, clock });
    return { ...store, close: async () => {} }; // suite stores share the pool
  });

  test('[postgres] restart persistence: sessions survive a full process handover', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE handoff_sessions');

    // "Instance one" writes and shuts down entirely.
    const poolA = createOperationalPool({ connectionString: PG_URL });
    const storeA = createPostgresHandoffStore({ pool: poolA, clock });
    const { session } = makeSession();
    await storeA.create(session);
    await storeA.close(); // drains poolA — the process is gone

    // "Instance two" starts fresh and continues the same session lifecycle.
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresHandoffStore({ pool: poolB, clock });
    const reloaded = await storeB.get(session.sessionId);
    assert.equal(reloaded.status, 'awaiting-transfer');
    assert.equal(reloaded.caller.email, 'caller@example.com');

    const redeemed = await storeB.redeem(session.tokenHash);
    assert.equal(redeemed.status, 'connected');
    const { session: done } = await storeB.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME });
    assert.equal(done.status, 'booked');
    await storeB.close();
  });

  test('[postgres] two API instances, one database: full demo flow with exactly one summary email', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE handoff_sessions');
    const SECRET = 'operational-test-secret';

    function fakeMailer() {
      const sends = [];
      return { sends, enabled: true, async sendSummary(m) { sends.push(m); return { status: 'sent' }; } };
    }

    const mailers = [fakeMailer(), fakeMailer()];
    const stores = [
      createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock }),
      createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock }),
    ];
    const apps = stores.map((handoffStore, i) => createApp({
      clock, handoffStore, demoBridgeSecret: SECRET, mailer: mailers[i], corsAllowedOrigins: 'https://guideherd.ai',
    }));
    const servers = apps.map((app) => http.createServer(app.handler));
    await Promise.all(servers.map((s) => new Promise((r) => s.listen(0, r))));
    const bases = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
    const auth = { authorization: `Bearer ${SECRET}` };
    const post = (base, p, body, headers = {}) => fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    try {
      // Prepare on instance 0 — visible to instance 1.
      const created = await (await post(bases[0], '/api/v1/handoffs', {
        firmId: 'martinson-beason',
        caller: { fullName: 'Cross Instance', email: 'cross@example.com', phone: '+15550111' },
        scheduling: { attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
        handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
      })).json();

      // Concurrent connects across BOTH instances: exactly one succeeds.
      const connects = await Promise.all([
        post(bases[0], '/api/v1/demo/connect', {}, auth),
        post(bases[1], '/api/v1/demo/connect', {}, auth),
        post(bases[0], '/api/v1/demo/connect', {}, auth),
        post(bases[1], '/api/v1/demo/connect', {}, auth),
      ]);
      const okConnects = connects.filter((r) => r.status === 200);
      assert.equal(okConnects.length, 1, 'exactly one cross-instance connect succeeds');

      // Status from the OTHER instance sees the connected state.
      const otherBase = bases[1];
      const statusRes = await fetch(`${otherBase}/api/v1/handoffs/${created.sessionId}`, {
        headers: { authorization: `Bearer ${created.consoleToken}` },
      });
      assert.equal((await statusRes.json()).status, 'connected');

      // Concurrent duplicate outcomes across both instances: one email total.
      const outcome = {
        sessionId: created.sessionId,
        status: 'booked',
        appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
        reason: 'Initial consultation booked.',
      };
      const outcomes = await Promise.all([
        post(bases[0], '/api/v1/demo/outcome', outcome, auth),
        post(bases[1], '/api/v1/demo/outcome', outcome, auth),
        post(bases[0], '/api/v1/demo/outcome', outcome, auth),
      ]);
      assert.ok(outcomes.every((r) => r.status === 200), 'idempotent duplicates all answer 200');
      assert.equal(mailers[0].sends.length + mailers[1].sends.length, 1, 'exactly one summary email across instances');

      // Conflicting outcome from either instance is rejected.
      const conflict = await post(bases[1], '/api/v1/demo/outcome',
        { sessionId: created.sessionId, status: 'failed', reason: 'Changed mind.' }, auth);
      assert.equal(conflict.status, 409);

      // Summary is readable from either instance.
      const summary = await fetch(`${bases[1]}/api/v1/demo/summary/latest`, { headers: auth });
      assert.equal(summary.status, 200);
      assert.ok((await summary.text()).includes('Cross Instance'));

      // Persisted-row scan: hashes only, no raw tokens, no bridge secret,
      // no vendor payloads.
      const { rows } = await sharedPool.query('SELECT * FROM handoff_sessions');
      const flat = JSON.stringify(rows);
      assert.equal(/gh_handoff_|gh_console_/.test(flat), false, 'no raw tokens at rest');
      assert.equal(flat.includes(SECRET), false, 'no bridge secret at rest');
      assert.equal(/ElevenLabs|Twilio|Cal\.com|transcript|recording/i.test(flat), false, 'no provider material at rest');
    } finally {
      servers.forEach((s) => s.closeAllConnections());
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      await Promise.all(stores.map((s) => s.close()));
    }
  });

  test('[postgres] restart persistence: phone correlation works across a process handover', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE handoff_sessions');

    // "Instance one" prepares two callers and shuts down entirely.
    const poolA = createOperationalPool({ connectionString: PG_URL });
    const storeA = createPostgresHandoffStore({ pool: poolA, clock });
    const first = makeSession({ phone: '+12565550101' });
    const second = makeSession({ phone: '+12565550102' });
    await storeA.create(first.session);
    await storeA.create(second.session);
    await storeA.close();

    // "Instance two" correlates by phone against the durable rows.
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresHandoffStore({ pool: poolB, clock });
    const connected = await storeB.connectEligible('org-a', { callerPhoneNormalized: '+12565550102' });
    assert.equal(connected.sessionId, second.session.sessionId);
    assert.equal(connected.status, 'connected');
    assert.equal((await storeB.get(first.session.sessionId)).status, 'awaiting-transfer', 'the other caller is untouched');
    await storeB.close();
  });

  test('[postgres] cross-instance connects for different callers proceed in parallel', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE handoff_sessions');
    const storeA = createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock });
    const storeB = createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock });
    try {
      const first = makeSession({ phone: '+12565550101' });
      const second = makeSession({ phone: '+12565550102' });
      await storeA.create(first.session);
      await storeA.create(second.session);

      const [ra, rb] = await Promise.all([
        storeA.connectEligible('org-a', { callerPhoneNormalized: '+12565550101' }),
        storeB.connectEligible('org-a', { callerPhoneNormalized: '+12565550102' }),
      ]);
      assert.equal(ra.sessionId, first.session.sessionId);
      assert.equal(rb.sessionId, second.session.sessionId);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  test('[postgres] atomic prepared-session cap: a hard limit across two repository instances', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE handoff_sessions');
    const storeA = createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock });
    const storeB = createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock });
    const CAP = 3;
    try {
      // Twelve concurrent creates for ONE organization, alternating between
      // two independent repository instances sharing the database: the
      // per-organization advisory transaction lock serializes them, so
      // exactly CAP succeed and the table can never overshoot.
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? storeA : storeB).create(
          makeSession({ phone: `+155503${String(i).padStart(2, '0')}` }).session,
          { maxEligiblePrepared: CAP },
        )),
      );
      assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, CAP, 'exactly cap cross-instance successes');
      assert.equal(
        attempts.filter((r) => r.status === 'rejected' && r.reason.status === 429 && r.reason.code === 'too_many_prepared_sessions').length,
        12 - CAP,
      );
      const { rows } = await sharedPool.query(
        `SELECT count(*)::int AS n FROM handoff_sessions WHERE organization_key = 'org-a' AND status = 'awaiting-transfer'`,
      );
      assert.equal(rows[0].n, CAP, 'the database holds exactly cap prepared rows — the limit is hard');

      // A different organization is not serialized away from its capacity.
      await storeB.create(makeSession({ firmId: 'org-b' }).session, { maxEligiblePrepared: CAP });
      assert.equal(await storeB.countEligible('org-b'), 1);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  test('[postgres] cross-instance cancel vs connect: one winner', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE handoff_sessions');
    const storeA = createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock });
    const storeB = createPostgresHandoffStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock });
    try {
      const { session, consoleTokenHash } = makeSession();
      await storeA.create(session);
      const [cancelled, connected] = await Promise.allSettled([
        storeA.cancel(session.sessionId, consoleTokenHash),
        storeB.connectDemo('org-a'),
      ]);
      const winners = [cancelled, connected].filter((r) => r.status === 'fulfilled');
      assert.equal(winners.length, 1, 'exactly one instance wins');
      const final = (await storeA.get(session.sessionId)).status;
      assert.ok(['cancelled', 'connected'].includes(final));
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  test('[postgres] notification delivery store: claim/record contract and cross-instance exactly-once', async () => {
    const { createPostgresNotificationDeliveryStore } = require('./notification-deliveries');
    const { STALE_CLAIM_MS } = require('../handoff/store');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE notification_deliveries');
    const storeA = createPostgresNotificationDeliveryStore({ pool: sharedPool, clock });
    const KEY = 'appointment-confirmation:sess-1';

    // First claim wins; a concurrent second claim is refused.
    const claims = await Promise.all(Array.from({ length: 6 }, () => storeA.claim(KEY)));
    assert.equal(claims.filter((c) => c.claimed).length, 1, 'exactly one concurrent claimant');

    // failed permits re-claim; sent is final forever.
    await storeA.record(KEY, 'failed');
    assert.equal((await storeA.claim(KEY)).claimed, true, 'failed permits retry');
    await storeA.record(KEY, 'sent');
    clock.set(T0 + STALE_CLAIM_MS * 10);
    const afterSent = await storeA.claim(KEY);
    assert.equal(afterSent.claimed, false, 'sent is never re-claimed — no duplicate notification, ever');
    assert.equal(afterSent.status, 'sent');

    // A stale pending claim (claimant crashed) is re-claimable.
    clock.set(T0);
    await storeA.claim('nk-stale');
    clock.set(T0 + STALE_CLAIM_MS - 1);
    assert.equal((await storeA.claim('nk-stale')).claimed, false, 'fresh pending blocks');
    clock.set(T0 + STALE_CLAIM_MS);
    assert.equal((await storeA.claim('nk-stale')).claimed, true, 'stale pending re-claimable');

    // Cross-instance: a second repository instance sees sent-finality.
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresNotificationDeliveryStore({ pool: poolB, clock });
    assert.equal((await storeB.claim(KEY)).claimed, false, 'sent is final across instances');
    await poolB.end();

    // Nothing sensitive at rest: keys and statuses only.
    const { rows } = await sharedPool.query('SELECT * FROM notification_deliveries');
    assert.equal(/@|caller|phone|subject|html/i.test(JSON.stringify(rows)), false);
  });

  test('[postgres] outbox: transactional publishing — the event commits and rolls back WITH the business change', async () => {
    const { createPostgresOutboxStore } = require('./outbox-store');
    const { createPostgresHandoffStore: mkStore } = require('./session-repository');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE outbox_deliveries, outbox_events');
    await sharedPool.query('TRUNCATE handoff_sessions');
    const outbox = createPostgresOutboxStore({ pool: sharedPool, clock });
    const store = mkStore({ pool: sharedPool, clock, outbox });

    // Success: outcome + event commit together.
    const { session } = makeSession();
    await store.create(session);
    await store.connectEligible('org-a', { sessionId: session.sessionId }, { correlationId: 'gh-outbox00000000000000001' });
    await store.applyOutcome(session.sessionId, { ...BOOKED_OUTCOME }, { correlationId: 'gh-outbox00000000000000001' });
    const events = await outbox.listRecent({ organizationKey: 'org-a' });
    assert.deepEqual(events.map((e) => e.type), ['conversation.completed', 'conversation.connected']);
    assert.equal(events[0].correlationId, 'gh-outbox00000000000000001');

    // Failure: a rejected business operation publishes NOTHING (the
    // conflicting outcome rolls back, and its would-be event with it).
    await assert.rejects(() => store.applyOutcome(session.sessionId, { status: 'failed', schedulingSummary: 'No.' }, {}));
    assert.equal(await outbox.size(), 2, 'no event exists for a failed business operation');

    // Idempotent duplicate: no new event either.
    await store.applyOutcome(session.sessionId, JSON.parse(JSON.stringify(BOOKED_OUTCOME)), {});
    assert.equal(await outbox.size(), 2);
  });

  test('[postgres] outbox: restart recovery and cross-instance exactly-one claim', async () => {
    const { createPostgresOutboxStore } = require('./outbox-store');
    const { createOutbox } = require('../outbox/outbox');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE outbox_deliveries, outbox_events');
    const storeA = createPostgresOutboxStore({ pool: sharedPool, clock });
    const appended = await storeA.append({ type: 'conversation.completed', organizationKey: 'org-a', sessionId: 's-1', payload: { status: 'booked' } });

    // "Instance one" dies before processing. "Instance two" boots, drains,
    // and the durable event is delivered exactly once across BOTH
    // instances' processors claiming concurrently.
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresOutboxStore({ pool: poolB, clock });
    let handled = 0;
    const mkProcessor = (s) => {
      const processor = createOutbox({ store: s, clock });
      processor.register({ consumer: 'notifications', async handle() { handled += 1; } });
      return processor;
    };
    const [pa, pb] = [mkProcessor(storeA), mkProcessor(storeB)];
    await Promise.all([pa.drain(), pb.drain()]);
    assert.equal(handled, 1, 'at-least-once delivery, exactly one concurrent claimant');
    assert.equal((await storeA.deliveryOf(appended.id, 'notifications')).status, 'completed');

    // Duplicate suppression across a later restart: a fresh processor
    // finds nothing to do.
    const pc = mkProcessor(storeB);
    await pc.drain();
    assert.equal(handled, 1, 'completed deliveries never redeliver');
    await poolB.end();
  });

  test('[postgres] teardown', async () => {
    await sharedPool.end();
  });
}

// ---------------------------------------------------------------------------
// Boot behavior (spawned like Railway runs it) — provider selection
// ---------------------------------------------------------------------------

const SERVER_JS = path.join(__dirname, '..', 'server.js');

function spawnServer(extraEnv) {
  return spawn(process.execPath, ['--experimental-sqlite', SERVER_JS], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', GUIDEHERD_CONFIG_DB: ':memory:', ...extraEnv },
  });
}

function collectExit(child) {
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })));
}

test('boot: postgres provider with an unreachable database exits non-zero (no silent fallback)', async () => {
  const child = spawnServer({
    GUIDEHERD_OPERATIONAL_PROVIDER: 'postgres',
    GUIDEHERD_OPERATIONAL_DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
  });
  const { code, output } = await collectExit(child);
  assert.equal(code, 1);
  assert.ok(output.includes('refusing to start'), 'failure is loud and explicit');
});

test('boot: postgres provider with no connection string exits non-zero', async () => {
  const env = { GUIDEHERD_OPERATIONAL_PROVIDER: 'postgres' };
  // Ensure inherited URLs cannot leak in.
  const child = spawn(process.execPath, ['--experimental-sqlite', SERVER_JS], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: '', GUIDEHERD_OPERATIONAL_DATABASE_URL: '', PORT: '0', GUIDEHERD_CONFIG_DB: ':memory:', ...env },
  });
  const { code, output } = await collectExit(child);
  assert.equal(code, 1);
  assert.ok(/requires a PostgreSQL connection string|refusing to start/.test(output));
});

test('boot: an unknown operational provider exits non-zero rather than defaulting', async () => {
  const child = spawnServer({ GUIDEHERD_OPERATIONAL_PROVIDER: 'redis' });
  const { code, output } = await collectExit(child);
  assert.equal(code, 1);
  assert.ok(output.includes('Unknown GUIDEHERD_OPERATIONAL_PROVIDER'));
});
