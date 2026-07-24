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
const { createInMemoryBookingContextStore } = require('../scheduling/booking-context-store');
const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { runHandoffRepositoryContractSuite, makeSession, BOOKED_OUTCOME } = require('./contract-suite');
const {
  runBookingContextContractSuite, makeContext, SLOT_A,
} = require('./booking-context-contract-suite');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const PG_URL = process.env.GUIDEHERD_TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Contract suite — in-memory reference implementation (always runs)
// ---------------------------------------------------------------------------

runHandoffRepositoryContractSuite('memory', async ({ clock }) => createInMemoryHandoffStore({ clock }));
runBookingContextContractSuite('memory', async ({ clock, audit }) => createInMemoryBookingContextStore({ clock, audit }));

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

  function configServiceWithFirm() {
    const { openDatabase } = require('../config/db');
    const { migrate: migrateConfig } = require('../config/migrate');
    const { createConfigService } = require('../config/service');
    const db = openDatabase();
    migrateConfig(db);
    const cs = createConfigService({ db });
    cs.organizations.create({ key: 'martinson-beason', name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
    return cs;
  }

  /** One shared pool for the suite; contract stores share it (close unused). */
  let sharedPool;

  async function resetDatabase(pool) {
    await pool.query('DROP TABLE IF EXISTS user_sessions');
    await pool.query('DROP TABLE IF EXISTS workflow_signals');
    await pool.query('DROP TABLE IF EXISTS workflow_steps');
    await pool.query('DROP TABLE IF EXISTS workflow_instances');
    await pool.query('DROP TABLE IF EXISTS integration_deliveries');
    await pool.query('DROP TABLE IF EXISTS outbox_deliveries');
    await pool.query('DROP TABLE IF EXISTS outbox_events');
    await pool.query('DROP TABLE IF EXISTS scheduled_actions');
    await pool.query('DROP TABLE IF EXISTS scheduling_audit');
    await pool.query('DROP TABLE IF EXISTS booking_contexts');
    await pool.query('DROP TABLE IF EXISTS handoff_sessions');
    await pool.query('DROP TABLE IF EXISTS notification_deliveries');
    await pool.query('DROP TABLE IF EXISTS operational_schema_migrations');
  }

  test('[postgres] migrations: fresh apply, idempotent re-run, concurrent runners serialize', async () => {
    sharedPool = createOperationalPool({ connectionString: PG_URL });
    await resetDatabase(sharedPool);

    assert.equal(await migrate(sharedPool), 10, 'all pending migrations apply');
    assert.equal(await migrate(sharedPool), 0, 're-run is a no-op');

    // Concurrent boots: several runners at once, advisory lock serializes.
    await resetDatabase(sharedPool);
    const pools = [createOperationalPool({ connectionString: PG_URL }), createOperationalPool({ connectionString: PG_URL })];
    const results = await Promise.all([migrate(sharedPool), migrate(pools[0]), migrate(pools[1])]);
    assert.equal(results.reduce((a, b) => a + b, 0), 10, 'exactly one runner applies the migrations');
    await Promise.all(pools.map((p) => p.end()));

    const { rows } = await sharedPool.query('SELECT count(*)::int AS n FROM operational_schema_migrations');
    assert.equal(rows[0].n, 10);
  });

  // Contract suite against PostgreSQL. Each test gets a truncated table on
  // the shared pool — same database, clean state, migrations already applied.
  runHandoffRepositoryContractSuite('postgres', async ({ clock }) => {
    await sharedPool.query('TRUNCATE handoff_sessions');
    const store = createPostgresHandoffStore({ pool: sharedPool, clock });
    return { ...store, close: async () => {} }; // suite stores share the pool
  });

  const { createPostgresBookingContextStore } = require('./booking-context-repository');

  runBookingContextContractSuite('postgres', async ({ clock, audit }) => {
    await sharedPool.query('TRUNCATE booking_contexts');
    return createPostgresBookingContextStore({ pool: sharedPool, clock, audit });
  });

  test('[postgres] booking contexts: the DATABASE enforces route-kind consistency, not just the JS layer', async () => {
    await sharedPool.query('TRUNCATE booking_contexts');
    // Raw INSERTs bypass assertRouteConsistency entirely — the CHECK
    // constraints must reject them on their own.
    const insert = (cols) => sharedPool.query(
      `INSERT INTO booking_contexts (
         booking_context_id, context_token_hash, organization_key,
         route_kind, attorney_id, routing_group_key, practice_area_id,
         event_type_id, duration_minutes, offered_slots, status,
         created_at, updated_at, expires_at
       ) VALUES ($1,$2,'org-a',$3,$4,$5,$6,$7,$8,'["2026-09-01T14:00:00.000Z"]','offered',now(),now(),now())`,
      cols,
    );
    // attorney route without an attorney.
    await assert.rejects(() => insert(['bc_x1', 'h1', 'attorney', null, null, null, 6287134, 30]),
      /booking_contexts_route_consistency/);
    // routing-group route carrying an attorney.
    await assert.rejects(() => insert(['bc_x2', 'h2', 'routing-group', 'clay-martinson', 'probate', 'probate', 6330099, 30]),
      /booking_contexts_route_consistency/);
    // routing-group route without a practice area.
    await assert.rejects(() => insert(['bc_x3', 'h3', 'routing-group', null, 'probate', null, 6330099, 30]),
      /booking_contexts_route_consistency/);
    // default route carrying a routing group.
    await assert.rejects(() => insert(['bc_x4', 'h4', 'default', null, 'probate', null, 6287134, 30]),
      /booking_contexts_route_consistency/);
    // unknown route kind, nonpositive event type, nonpositive duration.
    await assert.rejects(() => insert(['bc_x5', 'h5', 'walk-in', null, null, null, 6287134, 30]), /route/);
    await assert.rejects(() => insert(['bc_x6', 'h6', 'default', null, null, null, 0, 30]), /event_type_id/);
    await assert.rejects(() => insert(['bc_x7', 'h7', 'default', null, null, null, 6287134, 0]), /duration_minutes/);
    // The three valid shapes insert cleanly.
    await insert(['bc_ok1', 'h8', 'attorney', 'clay-martinson', null, null, 6287134, 30]);
    await insert(['bc_ok2', 'h9', 'routing-group', null, 'probate', 'probate', 6330099, 30]);
    await insert(['bc_ok3', 'h10', 'default', null, null, null, 6287134, 30]);
  });

  test('[postgres] booking contexts: restart persistence — a claim survives a full process handover and completes on the next instance', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE booking_contexts');

    // "Instance one" offers and claims, then shuts down entirely.
    const poolA = createOperationalPool({ connectionString: PG_URL });
    const storeA = createPostgresBookingContextStore({ pool: poolA, clock });
    const input = makeContext();
    await storeA.create(input);
    await storeA.claim({ bookingContextId: input.bookingContextId, startsAt: SLOT_A });
    await poolA.end(); // the process is gone

    // "Instance two" starts fresh: state and status are intact, and the
    // outcome records durably.
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresBookingContextStore({ pool: poolB, clock });
    const reloaded = await storeB.findByTokenHash({
      contextTokenHash: input.contextTokenHash, organizationKey: 'org-a',
    });
    assert.equal(reloaded.status, 'booking_in_progress');
    assert.equal(reloaded.eventTypeId, 6287134);
    assert.deepEqual(reloaded.offeredSlots, input.offeredSlots);
    const booked = await storeB.complete({
      bookingContextId: input.bookingContextId, status: 'booked', calcomBookingUid: 'uid_handover',
    });
    assert.equal(booked.status, 'booked');
    await poolB.end();
  });

  test('[postgres] migration 0008 is ADDITIVE: applies cleanly onto an existing 0007 database without touching prior data', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const pathMod = require('node:path');
    await resetDatabase(sharedPool);
    // A database exactly as the previous release left it: 0001–0007 only.
    const stagedDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'gh-mig-'));
    for (const file of fs.readdirSync(pathMod.join(__dirname, 'migrations')).sort().slice(0, 7)) {
      fs.copyFileSync(pathMod.join(__dirname, 'migrations', file), pathMod.join(stagedDir, file));
    }
    assert.equal(await migrate(sharedPool, { dir: stagedDir }), 7, 'the 0007-era schema applies');
    const clock = fixedClock(T0);
    const legacyStore = createPostgresHandoffStore({ pool: sharedPool, clock });
    const { session } = makeSession();
    await legacyStore.create(session);
    // The new release boots: exactly 0008 applies; prior rows are intact.
    assert.equal(await migrate(sharedPool), 3, 'exactly 0008, 0009, and 0010 are pending');
    assert.equal(await migrate(sharedPool), 0, 'second run applies nothing');
    assert.equal((await legacyStore.get(session.sessionId)).status, 'awaiting-transfer', 'existing data untouched');
    const { rows } = await sharedPool.query('SELECT count(*)::int AS n FROM booking_contexts');
    assert.equal(rows[0].n, 0, 'the new table exists and is empty');
    // Restore the fully-migrated shared database for later tests.
    fs.rmSync(stagedDir, { recursive: true, force: true });
  });

  test('[postgres] migration 0009 is ADDITIVE onto a live 0008 database: legacy rows intact, native rules enforced', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const pathMod = require('node:path');
    await resetDatabase(sharedPool);
    // A database exactly as the 0008 release left it.
    const stagedDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'gh-mig9-'));
    for (const file of fs.readdirSync(pathMod.join(__dirname, 'migrations')).sort().slice(0, 8)) {
      fs.copyFileSync(pathMod.join(__dirname, 'migrations', file), pathMod.join(stagedDir, file));
    }
    assert.equal(await migrate(sharedPool, { dir: stagedDir }), 8, 'the 0008-era schema applies');
    // A row written by the 0008-era writer (raw SQL: the current
    // repository code targets the 0009 column set).
    const legacy = makeContext();
    await sharedPool.query(
      `INSERT INTO booking_contexts (
         booking_context_id, context_token_hash, organization_key, route_kind,
         attorney_id, consultation_type_id, event_type_id, duration_minutes,
         offered_slots, status, created_at, updated_at, expires_at
       ) VALUES ($1,$2,$3,'attorney','clay-martinson','initial-consultation',$4,30,$5,'offered',$6,$6,$7)`,
      [legacy.bookingContextId, legacy.contextTokenHash, legacy.organizationKey,
        legacy.eventTypeId, JSON.stringify(legacy.offeredSlots), new Date(T0), new Date(T0 + 10 * 60 * 1000)],
    );
    // The new release boots: exactly 0009 applies; the legacy row is intact
    // and fully operable through the NEW repository.
    assert.equal(await migrate(sharedPool), 2, 'exactly 0009 and 0010 are pending');
    const clock = fixedClock(T0);
    const store = createPostgresBookingContextStore({ pool: sharedPool, clock });
    const reloaded = await store.get(legacy.bookingContextId);
    assert.equal(reloaded.status, 'offered');
    assert.equal(reloaded.eventTypeId, legacy.eventTypeId);
    assert.equal(reloaded.providerKey, null);
    assert.equal(reloaded.providerEventId, null);
    assert.ok(await store.claim({ bookingContextId: legacy.bookingContextId, startsAt: SLOT_A }),
      'legacy rows keep working under the evolved schema');

    // The DATABASE (not just JS) enforces target presence: a row with
    // neither an event type nor a native provider is unwritable.
    await assert.rejects(sharedPool.query(
      `INSERT INTO booking_contexts (
         booking_context_id, context_token_hash, organization_key, route_kind,
         attorney_id, duration_minutes, offered_slots, status, created_at, updated_at, expires_at
       ) VALUES ('bc_bad','hash_bad','org-a','attorney','clay-martinson',30,'[]','offered',now(),now(),now())`,
    ), /target_presence/);

    // The slot-guard partial unique index binds at the DATABASE level.
    await sharedPool.query(
      `UPDATE booking_contexts SET provider_key = 'reference', calendar_ref = 'cal-guard',
              offered_targets = '{}'::jsonb WHERE booking_context_id = $1`,
      [legacy.bookingContextId],
    );
    await assert.rejects(sharedPool.query(
      `INSERT INTO booking_contexts (
         booking_context_id, context_token_hash, organization_key, route_kind, attorney_id,
         provider_key, calendar_ref, offered_targets, selected_starts_at,
         duration_minutes, offered_slots, status, created_at, updated_at, expires_at
       ) VALUES ('bc_dup','hash_dup',$1,'attorney','clay-martinson',
         'reference','cal-guard','{}'::jsonb,$2,30,$3,'booking_in_progress',now(),now(),now())`,
      [legacy.organizationKey, new Date(SLOT_A), JSON.stringify([SLOT_A])],
    ), /slot_guard/);

    fs.rmSync(stagedDir, { recursive: true, force: true });
    // Restore the fully-migrated shared database for later tests.
    await resetDatabase(sharedPool);
    await migrate(sharedPool);
  });

  test('[postgres] scheduling_audit: the durable sink records and lists; a broken pool is telemetry, not a failure', async () => {
    await sharedPool.query('TRUNCATE scheduling_audit');
    const { createPostgresSchedulingAudit } = require('./scheduling-audit');
    const audit = createPostgresSchedulingAudit({ pool: sharedPool });
    await audit.record({
      bookingContextId: 'bc_audit-1', organizationKey: 'org-a',
      occurredAtMs: T0, actor: 'caller-flow', action: 'created', detail: { routeKind: 'attorney' },
    });
    await audit.record({
      bookingContextId: 'bc_audit-1', organizationKey: 'org-a',
      occurredAtMs: T0 + 1000, actor: 'reconciler', action: 'verification_required',
      detail: { reason: 'stale_booking_in_progress' },
    });
    const trail = await audit.listByContext('bc_audit-1');
    assert.deepEqual(trail.map((r) => [r.action, r.actor]), [
      ['created', 'caller-flow'], ['verification_required', 'reconciler'],
    ]);
    assert.deepEqual(trail[1].detail, { reason: 'stale_booking_in_progress' });

    // A sink over a broken pool NEVER throws — loud telemetry instead.
    const events = [];
    const broken = createPostgresSchedulingAudit({
      pool: { query: async () => { throw new Error('pool down'); } },
      telemetry: { event: (name, fields) => events.push({ name, fields }) },
    });
    await broken.record({
      bookingContextId: 'bc_x', organizationKey: 'org-a', occurredAtMs: T0, actor: 'system', action: 'expired',
    });
    assert.equal(events[0].name, 'internal.unexpected_error');
    assert.equal(events[0].fields.code, 'audit_write_failed');
  });

  test('[postgres] migration 0008 details: jsonb round-trips, bigint precision, unique hash, and the intended index predicates', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE booking_contexts');
    const store = createPostgresBookingContextStore({ pool: sharedPool, clock });

    // bigint event_type_id: the largest safe JS integer round-trips
    // exactly as a NUMBER (no string leakage, no precision loss).
    const big = makeContext({ eventTypeId: Number.MAX_SAFE_INTEGER });
    await store.create(big);
    const reloaded = await store.get(big.bookingContextId);
    assert.equal(typeof reloaded.eventTypeId, 'number');
    assert.equal(reloaded.eventTypeId, 9007199254740991);

    // jsonb: offered_slots and booking_result store and return structure.
    const { rows: jsonbRows } = await sharedPool.query(
      "SELECT jsonb_typeof(offered_slots) AS t, offered_slots->0 AS first FROM booking_contexts WHERE booking_context_id = $1",
      [big.bookingContextId],
    );
    assert.equal(jsonbRows[0].t, 'array');
    assert.equal(jsonbRows[0].first, SLOT_A);
    await store.claim({ bookingContextId: big.bookingContextId, startsAt: SLOT_A });
    await store.complete({
      bookingContextId: big.bookingContextId, status: 'booked',
      calcomBookingUid: 'uid_json', bookingResult: { uid: 'uid_json', start: SLOT_A },
    });
    const { rows: resultRows } = await sharedPool.query(
      "SELECT jsonb_typeof(booking_result) AS t, booking_result->>'uid' AS uid FROM booking_contexts WHERE booking_context_id = $1",
      [big.bookingContextId],
    );
    assert.equal(resultRows[0].t, 'object');
    assert.equal(resultRows[0].uid, 'uid_json');

    // context_token_hash is UNIQUE at the database.
    await assert.rejects(() => sharedPool.query(
      `INSERT INTO booking_contexts (booking_context_id, context_token_hash, organization_key, route_kind,
         attorney_id, event_type_id, duration_minutes, offered_slots, status, created_at, updated_at, expires_at)
       VALUES ('bc_dup', $1, 'org-a', 'attorney', 'clay-martinson', 1, 30, '[]', 'offered', now(), now(), now())`,
      [big.contextTokenHash],
    ), /unique|duplicate/i);

    // The partial indexes exist with the intended predicates.
    const { rows: indexes } = await sharedPool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'booking_contexts' ORDER BY indexname",
    );
    const byName = Object.fromEntries(indexes.map((r) => [r.indexname, r.indexdef]));
    assert.match(byName.booking_contexts_open_idx, /WHERE.*booking_in_progress.*verification_required/s,
      'reconciliation scans are supported by the open-status partial index');
    assert.match(byName.booking_contexts_session_idx, /WHERE.*session_id IS NOT NULL/s);
    assert.ok(byName.booking_contexts_context_token_hash_key, 'the unique hash constraint is index-backed (claim lookups)');
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

  // Workflow store (ADR-0021): the full shared contract suite on
  // PostgreSQL — the same suite the in-memory reference runs in
  // server/workflow/workflow.test.js.
  {
    const { runWorkflowStoreContractSuite } = require('../workflow/store-contract-suite');
    const { createPostgresWorkflowStore } = require('./workflow-store');
    runWorkflowStoreContractSuite('postgres', async ({ clock }) => {
      await sharedPool.query('TRUNCATE workflow_steps');
      await sharedPool.query('TRUNCATE workflow_instances');
      const store = createPostgresWorkflowStore({ pool: sharedPool, clock });
      return { ...store, close: async () => {} }; // suite stores share the pool
    });
  }

  test('[postgres] workflow signals: concurrent cross-instance delivery of one signal identity applies exactly one transition', async () => {
    const { createPostgresWorkflowStore } = require('./workflow-store');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE workflow_signals, workflow_steps, workflow_instances');
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeA = createPostgresWorkflowStore({ pool: sharedPool, clock });
    const storeB = createPostgresWorkflowStore({ pool: poolB, clock });
    await storeA.createInstance({
      instanceId: 'wfpg-1', workflowType: 'demo-follow-up', definitionVersion: 1,
      instanceKey: 'sess-race', organizationKey: 'org-a', relatedEntityId: null,
      state: 'a', stateData: {},
    });
    const step = (n) => ({ stepKey: `wfpg-1:a->b:${n}`, instanceId: 'wfpg-1', organizationKey: 'org-a', intent: { intent: 'notify' } });

    // Two API instances race the SAME durable signal identity.
    const results = await Promise.all([
      storeA.transition('wfpg-1', 'a', { toState: 'b', stateData: {}, steps: [step(0)], signalId: 'event:evt-race' }),
      storeB.transition('wfpg-1', 'a', { toState: 'b', stateData: {}, steps: [step(0)], signalId: 'event:evt-race' }),
    ]);
    assert.equal(results.filter((r) => r.applied).length, 1, 'exactly one winner');
    assert.equal((await storeA.get('wfpg-1')).state, 'b');
    assert.equal((await storeA.getStep('wfpg-1:a->b:0')).status, 'pending');
    // And the loser recorded nothing extra: one signal row, one step row.
    const { rows: sig } = await sharedPool.query("SELECT count(*)::int AS n FROM workflow_signals WHERE instance_id='wfpg-1'");
    assert.equal(sig[0].n, 1);
    await poolB.end();
  });

  test('[postgres] workflow signals: concurrent IGNORED delivery across two instances consumes exactly once', async () => {
    const { createPostgresWorkflowStore } = require('./workflow-store');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE workflow_signals, workflow_steps, workflow_instances');
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeA = createPostgresWorkflowStore({ pool: sharedPool, clock });
    const storeB = createPostgresWorkflowStore({ pool: poolB, clock });
    await storeA.createInstance({
      instanceId: 'wfpg-ign', workflowType: 'demo-follow-up', definitionVersion: 1,
      instanceKey: 'sess-ign', organizationKey: 'org-a', relatedEntityId: null,
      state: 'a', stateData: {},
    });

    // Two API instances evaluate the SAME structurally-valid-but-ignored
    // signal concurrently: exactly one consumption commits.
    const results = await Promise.all([
      storeA.transition('wfpg-ign', 'a', { toState: 'a', stateData: {}, steps: [], signalId: 'event:ign-race', signalOutcome: 'ignored' }),
      storeB.transition('wfpg-ign', 'a', { toState: 'a', stateData: {}, steps: [], signalId: 'event:ign-race', signalOutcome: 'ignored' }),
    ]);
    assert.equal(results.filter((r) => r.applied).length, 1, 'exactly one consumer');
    const { rows } = await sharedPool.query(
      "SELECT outcome FROM workflow_signals WHERE instance_id='wfpg-ign' AND signal_id='event:ign-race'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'ignored');
    assert.equal((await storeA.get('wfpg-ign')).state, 'a', 'no state change either way');
    await poolB.end();
  });

  test('[postgres] workflow signals: a pre-commit failure rolls the WHOLE transition back — signal, state, and steps — and retries safely', async () => {
    const { createPostgresWorkflowStore } = require('./workflow-store');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE workflow_signals, workflow_steps, workflow_instances');
    const store = createPostgresWorkflowStore({ pool: sharedPool, clock });
    await store.createInstance({
      instanceId: 'wfpg-2', workflowType: 'demo-follow-up', definitionVersion: 1,
      instanceKey: 'sess-crash', organizationKey: 'org-a', relatedEntityId: null,
      state: 'a', stateData: {},
    });

    // A step violating the schema (organization_key NOT NULL) makes the
    // transaction fail AFTER the signal insert and the state CAS.
    await assert.rejects(() => store.transition('wfpg-2', 'a', {
      toState: 'b', stateData: {},
      steps: [{ stepKey: 'wfpg-2:a->b:0', instanceId: 'wfpg-2', organizationKey: null, intent: { intent: 'notify' } }],
      signalId: 'event:evt-crash',
    }));
    // NOTHING committed: state, signal, and steps all rolled back.
    assert.equal((await store.get('wfpg-2')).state, 'a');
    assert.equal(await store.hasSignal('wfpg-2', 'event:evt-crash'), false, 'the failed delivery left no signal record');
    assert.equal(await store.getStep('wfpg-2:a->b:0'), undefined);

    // The SAME signal identity retries cleanly after the fault is fixed.
    const retry = await store.transition('wfpg-2', 'a', {
      toState: 'b', stateData: {},
      steps: [{ stepKey: 'wfpg-2:a->b:0', instanceId: 'wfpg-2', organizationKey: 'org-a', intent: { intent: 'notify' } }],
      signalId: 'event:evt-crash',
    });
    assert.deepEqual(retry, { applied: true });
    // And re-delivery AFTER commit is the durable duplicate no-op.
    const dup = await store.transition('wfpg-2', 'b', {
      toState: 'c', stateData: {}, steps: [], signalId: 'event:evt-crash',
    });
    assert.deepEqual(dup, { applied: false, duplicate: true });
  });

  // Integration delivery store (ADR-0020): the full shared contract suite
  // runs against PostgreSQL — the same suite the in-memory reference runs
  // in server/integrations/integrations.test.js, so the two implementations
  // cannot drift apart silently.
  {
    const { runIntegrationDeliveryStoreContractSuite } = require('../integrations/delivery-contract-suite');
    const { createPostgresIntegrationDeliveryStore } = require('./integration-deliveries');
    runIntegrationDeliveryStoreContractSuite('postgres', async ({ clock }) => {
      await sharedPool.query('TRUNCATE integration_deliveries');
      const store = createPostgresIntegrationDeliveryStore({ pool: sharedPool, clock });
      return { ...store, close: async () => {} }; // suite stores share the pool
    });
  }

  test('[postgres] integration delivery store: cross-instance exactly-once — completed is final across pools', async () => {
    const { createPostgresIntegrationDeliveryStore } = require('./integration-deliveries');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE integration_deliveries');
    const storeA = createPostgresIntegrationDeliveryStore({ pool: sharedPool, clock });
    const KEY = 'demo-record-sync:sess-xinstance';

    // Concurrent claims across the same key: exactly one winner.
    const claims = await Promise.all(Array.from({ length: 6 }, () => storeA.claim(KEY)));
    assert.equal(claims.filter((c) => c.claimed).length, 1, 'exactly one concurrent claimant');
    await storeA.record(KEY, 'completed');

    // A second instance (its own pool) sees completed-finality.
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresIntegrationDeliveryStore({ pool: poolB, clock });
    const cross = await storeB.claim(KEY);
    assert.equal(cross.claimed, false, 'completed is never re-claimed — no duplicate external effect, ever');
    assert.equal(cross.status, 'completed');
    await poolB.end();
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

  test('[postgres] scheduler: durable scheduled actions — dedupe, claims, retries, expiry, cross-instance', async () => {
    const { createPostgresScheduledActionStore } = require('./scheduled-actions');
    const { createScheduler, SCHEDULER_STALE_PROCESSING_MS } = require('../scheduler/scheduler');
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE scheduled_actions');
    const store = createPostgresScheduledActionStore({ pool: sharedPool, clock });

    // Structural dedupe: the primary key is the idempotency boundary.
    const action = {
      actionKey: 'appointment-reminder:s-1:24h', actionType: 'appointment-reminder',
      organizationKey: 'org-a', sessionId: 's-1', correlationId: 'gh-sched00000000000000001',
      runAtMs: T0 + 1000, expiresAtMs: T0 + 100_000, payload: { slot: '24h' },
    };
    assert.equal((await store.schedule(action)).scheduled, true);
    assert.equal((await store.schedule(action)).scheduled, false, 'duplicate scheduling is inert');
    assert.equal(await store.size(), 1);
    const stored = await store.get(action.actionKey);
    assert.equal(stored.state, 'pending');
    assert.equal(stored.runAtMs, T0 + 1000);
    assert.deepEqual(stored.payload, { slot: '24h' });

    // Not due: unclaimable. Due: presented ready, atomically claimed once
    // across two instances sharing the database.
    assert.equal(await store.claim(action.actionKey, { maxAttempts: 3 }), null, 'never claims early');
    clock.advance(1000);
    assert.equal((await store.get(action.actionKey)).presentedState, 'ready');
    const poolB = createOperationalPool({ connectionString: PG_URL });
    const storeB = createPostgresScheduledActionStore({ pool: poolB, clock });
    const claims = await Promise.all([
      store.claim(action.actionKey, { maxAttempts: 3 }),
      storeB.claim(action.actionKey, { maxAttempts: 3 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'exactly one instance wins the claim');

    // Retry metadata: failed with a next attempt, re-claimable only when due.
    await store.fail(action.actionKey, { nextAttemptAtMs: clock.now() + 5000 });
    assert.equal(await store.claim(action.actionKey, { maxAttempts: 3 }), null, 'backoff holds');
    clock.advance(5000);
    const retried = await store.claim(action.actionKey, { maxAttempts: 3 });
    assert.equal(retried.attempts, 2);
    // Exhaustion: attempts at the cap never re-claim.
    await store.fail(action.actionKey, { nextAttemptAtMs: null });
    clock.advance(60_000);
    assert.equal(await store.claim(action.actionKey, { maxAttempts: 2 }), null, 'terminal failed never retries');

    // Stale processing reclaim (crashed executor on another instance).
    const crash = {
      actionKey: 'appointment-reminder:s-2:1h', actionType: 'appointment-reminder',
      organizationKey: 'org-a', sessionId: 's-2', runAtMs: clock.now(), payload: { slot: '1h' },
    };
    await store.schedule(crash);
    await storeB.claim(crash.actionKey, { maxAttempts: 3 }); // instance B claims, then dies
    assert.equal(await store.claim(crash.actionKey, { maxAttempts: 3 }), null, 'fresh claim honored');
    clock.advance(SCHEDULER_STALE_PROCESSING_MS);
    const reclaimed = await store.claim(crash.actionKey, { maxAttempts: 3 });
    assert.equal(reclaimed.attempts, 2, 'stale claim re-granted');
    await store.complete(crash.actionKey);
    assert.equal((await store.get(crash.actionKey)).state, 'completed');

    // Expiry: unexecuted work past expires_at dies instead of running late.
    const expiring = {
      actionKey: 'appointment-reminder:s-3:1h', actionType: 'appointment-reminder',
      organizationKey: 'org-a', sessionId: 's-3', runAtMs: clock.now() + 1000,
      expiresAtMs: clock.now() + 2000, payload: { slot: '1h' },
    };
    await store.schedule(expiring);
    clock.advance(10_000);
    const expired = await store.expireDue(clock.now());
    // s-3 expires; s-1's expiry has also long passed by now and it sits in
    // non-terminal 'failed' — worthless failed work past its expiry dies too.
    assert.deepEqual(expired.map((a) => a.actionKey).sort(),
      [action.actionKey, expiring.actionKey].sort());
    assert.equal((await store.get(expiring.actionKey)).state, 'expired');
    assert.equal(await store.claim(expiring.actionKey, { maxAttempts: 3 }), null, 'expired is terminal');

    // Cancellation is durable and terminal.
    const cancellable = {
      actionKey: 'consultation-follow-up:s-4', actionType: 'consultation-follow-up',
      organizationKey: 'org-a', sessionId: 's-4', runAtMs: clock.now() + 60_000, payload: {},
    };
    await store.schedule(cancellable);
    assert.equal((await store.cancel(cancellable.actionKey)).cancelled, true);
    assert.equal((await store.cancel(cancellable.actionKey)).cancelled, false);
    clock.advance(120_000);
    assert.equal(await store.claim(cancellable.actionKey, { maxAttempts: 3 }), null, 'cancelled never executes');

    // A full processor over the durable store: restart recovery.
    await sharedPool.query('TRUNCATE scheduled_actions');
    await store.schedule({
      actionKey: 'k:revive', actionType: 't', organizationKey: 'org-a', runAtMs: clock.now() - 1,
    });
    const ran = [];
    const revived = createScheduler({ store: storeB, clock });
    revived.register({ actionType: 't', handle: async (a) => { ran.push(a.actionKey); } });
    await revived.drain();
    assert.deepEqual(ran, ['k:revive'], 'a rebooted instance executes what a dead one scheduled');

    // Safe facts only in durable rows.
    const { rows } = await sharedPool.query('SELECT * FROM scheduled_actions');
    assert.equal(/@|caller|phone|subject|html|token/i.test(JSON.stringify(rows)), false);
    await poolB.end();
  });


  // ── Durable login sessions (ADR-0013 / #64) ──────────────────────────────
  // The SAME lifecycle suite the in-memory reference passes, plus the
  // durability guarantees only a real database can prove.
  const { runUserSessionLifecycleSuite } = require('../identity/user-session-contract-suite');
  const { createPostgresUserSessionStore } = require('./user-session-store');
  const { createUserSessionService: makeSessionService } = require('../identity/user-sessions');

  runUserSessionLifecycleSuite('postgres', async ({ clock }) => {
    await sharedPool.query('TRUNCATE user_sessions');
    return createPostgresUserSessionStore({ pool: sharedPool, clock });
  }, test);

  test('[postgres] sessions: SURVIVE a restart — a second service instance validates a first-instance token', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE user_sessions');
    const claim = { subject: 'op-sam', type: 'user', displayName: 'Sam Ops', organizationKey: 'org-a', roles: ['operator'] };

    // Instance A issues; instance B (fresh service over the same database —
    // exactly what a restarted or sibling process is) validates.
    const a = makeSessionService({ store: createPostgresUserSessionStore({ pool: sharedPool, clock }), clock, ttlSeconds: 3600 });
    const { token } = await a.establish(claim, 'dev-user');

    const b = makeSessionService({ store: createPostgresUserSessionStore({ pool: sharedPool, clock }), clock, ttlSeconds: 3600 });
    const validated = await b.validate(token);
    assert.equal(validated.identity.subject, 'op-sam', 'the session outlives the issuing instance');
    assert.ok(Object.isFrozen(validated.identity));

    // Logout on B is visible to A immediately — one durable truth.
    await b.invalidate(token);
    assert.equal(await a.validate(token), null, 'revocation is cross-instance');
  });

  test('[postgres] sessions: rows hold hashes and identity only — never a raw token; expired rows are purged on login', async () => {
    const clock = fixedClock(T0);
    await sharedPool.query('TRUNCATE user_sessions');
    const store = createPostgresUserSessionStore({ pool: sharedPool, clock });
    const service = makeSessionService({ store, clock, ttlSeconds: 60 });
    const { token } = await service.establish(
      { subject: 'op-sam', type: 'user', displayName: null, organizationKey: 'org-a', roles: ['operator'] }, 'dev-user');

    const { rows } = await sharedPool.query('SELECT * FROM user_sessions');
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes(token), false, 'the raw token never reaches the database');
    assert.equal(rows[0].token_hash.length, 64, 'SHA-256 hex hash keyed');

    // Expiry passes; the next establish() (login) purges the dead row.
    clock.set(T0 + 60_000);
    assert.equal(await service.validate(token), null);
    await service.establish({ subject: 'op-sam', type: 'user', displayName: null, organizationKey: 'org-a', roles: ['operator'] }, 'dev-user');
    const after = await sharedPool.query('SELECT COUNT(*) AS n FROM user_sessions');
    assert.equal(Number(after.rows[0].n), 1, 'login purged the expired row; only the live session remains');
    assert.equal(await store.size(), 1);
  });

  test('[postgres] COMPOSED APP: a login on one instance survives a restart — a second createApp over the same database validates the cookie, and logout is cross-instance', async () => {
    await sharedPool.query('TRUNCATE user_sessions');
    const clock = fixedClock(T0);
    const DEV_USERS = JSON.stringify([
      { key: 'dev-key-ops-0123456789abcdef', subject: 'op-sam', displayName: 'Sam Ops', organizationKey: 'martinson-beason', roles: ['operator'] },
    ]);
    // Two fully composed apps over the SAME database and the SAME durable
    // session store, exactly as server.js wires it under postgres — a
    // restart or a sibling instance is indistinguishable from this.
    const makeComposed = () => createApp({
      clock,
      configService: configServiceWithFirm(),
      devUsersJson: DEV_USERS,
      userSessionStore: createPostgresUserSessionStore({ pool: createOperationalPool({ connectionString: PG_URL }), clock }),
    });
    const appA = makeComposed();
    const appB = makeComposed();
    const servers = [appA, appB].map((a) => http.createServer(a.handler));
    await Promise.all(servers.map((sv) => new Promise((r) => sv.listen(0, r))));
    const [baseA, baseB] = servers.map((sv) => `http://127.0.0.1:${sv.address().port}`);
    try {
      // Sign in on instance A.
      const login = await fetch(`${baseA}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'dev-key-ops-0123456789abcdef' }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1];
      assert.ok(cookie.startsWith('gh_usession_'));

      // The RAW token never reached the database — only its hash.
      const rows = await sharedPool.query('SELECT * FROM user_sessions');
      assert.equal(rows.rows.length, 1);
      assert.equal(JSON.stringify(rows.rows).includes(cookie), false, 'raw token absent from PostgreSQL');

      // Instance B — the "restarted" / sibling process — validates the
      // cookie it never issued, through the composed HTTP surface.
      const whoB = await fetch(`${baseB}/api/v1/auth/session`, { headers: { cookie: `gh_session=${cookie}` } });
      assert.equal(whoB.status, 200, 'the session survives the restart / crosses instances');
      assert.equal((await whoB.json()).subject, 'op-sam');

      // Logout on B invalidates for A immediately — one durable truth.
      const logout = await fetch(`${baseB}/api/v1/auth/logout`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: `gh_session=${cookie}` }, body: '{}',
      });
      assert.equal(logout.status, 204);
      assert.equal((await fetch(`${baseA}/api/v1/auth/session`, { headers: { cookie: `gh_session=${cookie}` } })).status, 401,
        'cross-instance revocation');

      // Absolute expiry still holds across the composed surface: a fresh
      // login, then advance past the TTL — dead on BOTH instances.
      const login2 = await fetch(`${baseA}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'dev-key-ops-0123456789abcdef' }),
      });
      const cookie2 = (login2.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/)[1];
      clock.set(T0 + 12 * 60 * 60 * 1000);
      assert.equal((await fetch(`${baseA}/api/v1/auth/session`, { headers: { cookie: `gh_session=${cookie2}` } })).status, 401, 'absolute expiry survives restart');
      assert.equal((await fetch(`${baseB}/api/v1/auth/session`, { headers: { cookie: `gh_session=${cookie2}` } })).status, 401);
    } finally {
      servers.forEach((sv) => sv.closeAllConnections());
      await Promise.all(servers.map((sv) => new Promise((r) => sv.close(r))));
    }
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
