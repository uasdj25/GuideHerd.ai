'use strict';
/**
 * Backup/restore rehearsal (GitLab #62) — `npm run rehearse:restore`.
 *
 * Proves, on demand, that both stores can actually be restored: the
 * configuration store via a live `VACUUM INTO` snapshot served by a real
 * server boot, and the operational store via a logical dump restored into
 * a FRESH embedded PostgreSQL through the application's own migration
 * path (with sequence repair, proven by a post-restore write).
 *
 * Fully isolated: temp dirs, embedded PostgreSQL (devDependency) on
 * random localhost ports, SYNTHETIC data only (the test fixtures' fake
 * caller) — production is never touched and production data is never
 * used. Never prints credentials. Run quarterly and after schema-shaped
 * changes; paste the REHEARSAL RECORD block into
 * docs/operations/backup-and-restore.md §6.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');

const SERVER = path.join(__dirname, '..');
process.chdir(SERVER);
const { openDatabase } = require(path.join(SERVER, 'config/db'));
const { migrate: migrateConfig } = require(path.join(SERVER, 'config/migrate'));
const { createConfigService } = require(path.join(SERVER, 'config/service'));
const { run: seedRun } = require(path.join(SERVER, 'config/seed'));

const results = [];
const record = (line) => { results.push(line); console.log('  ' + line); };
const ms = (t0) => `${Date.now() - t0} ms`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  }).on('error', reject);
});

async function configStoreRehearsal(dir) {
  console.log('── Configuration store (SQLite): VACUUM INTO → restore → serve');
  const original = path.join(dir, 'config-live.db');
  const backup = path.join(dir, 'config-backup.db');
  const restored = path.join(dir, 'config-restored.db');

  // Live store: seeded + one "administration" edit that must survive.
  seedRun({ dbPath: original, filePath: path.join(SERVER, 'config/data/martinson-beason.example.json') });
  const live = openDatabase({ path: original });
  createConfigService({ db: live }).organizations.update('martinson-beason', { displayName: 'Restore Rehearsal Edit' });

  // BACKUP: consistent snapshot of the live database, no downtime.
  let t0 = Date.now();
  live.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  record(`config backup (VACUUM INTO, live db): ${ms(t0)}; size ${fs.statSync(backup).size} bytes`);
  live.close();

  // SIMULATED LOSS + RESTORE: copy the backup into place.
  fs.rmSync(original);
  t0 = Date.now();
  fs.copyFileSync(backup, restored);
  record(`config restore (file copy into place): ${ms(t0)}`);

  // VERIFY: the application starts against the restored store and serves
  // from it; the post-backup edit is present.
  t0 = Date.now();
  const port = await freePort();
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    cwd: SERVER,
    env: { ...process.env, GUIDEHERD_CONFIG_DB: restored, PORT: String(port), GUIDEHERD_OPERATIONAL_PROVIDER: 'memory' },
    stdio: 'ignore',
  });
  try {
    let res = null;
    for (let i = 0; i < 50 && !res; i++) {
      await new Promise((r) => setTimeout(r, 100));
      res = await get(port, '/api/v1/firms/martinson-beason/scheduling-options').catch(() => null);
    }
    if (!res || res.status !== 200) throw new Error(`scheduling-options ${res && res.status}`);
    const options = JSON.parse(res.body);
    if (!options.practiceAreas || options.practiceAreas.length === 0) throw new Error('no practice areas after restore');
    record(`config verify: app booted against restored store, scheduling-options 200 with ${options.practiceAreas.length} practice areas: ${ms(t0)}`);
  } finally {
    child.kill('SIGKILL');
  }
  const check = openDatabase({ path: restored });
  const name = createConfigService({ db: check }).organizations.get('martinson-beason').displayName;
  check.close();
  if (name !== 'Restore Rehearsal Edit') throw new Error('post-backup edit missing from restore');
  record('config verify: live administration edit survived the backup/restore cycle');
}

async function operationalStoreRehearsal(dir) {
  console.log('── Operational store (PostgreSQL): logical dump → fresh instance → app reads');
  const { createRequire } = require('node:module');
  const serverRequire = createRequire(path.join(SERVER, 'package.json'));
  const EmbeddedPostgresModule = serverRequire('embedded-postgres');
  const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;
  const { Pool } = serverRequire('pg');
  const { migrate } = require(path.join(SERVER, 'operational/migrate'));
  const { createPostgresHandoffStore } = require(path.join(SERVER, 'operational/session-repository'));
  const { createPostgresOutboxStore } = require(path.join(SERVER, 'operational/outbox-store'));
  const { systemClock } = require(path.join(SERVER, 'handoff/clock'));
  const { makeSession } = require(path.join(SERVER, 'operational/contract-suite'));

  const mkInstance = async (label) => {
    const dataDir = fs.mkdtempSync(path.join(dir, `pg-${label}-`));
    const port = await freePort();
    const password = crypto.randomBytes(24).toString('base64url');
    const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'guideherd', password, port, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('guideherd');
    const pool = new Pool({ host: '127.0.0.1', port, user: 'guideherd', password, database: 'guideherd', max: 4 });
    return { pg, pool, stop: async () => { await pool.end().catch(() => {}); await pg.stop().catch(() => {}); } };
  };

  const A = await mkInstance('a');
  const B = await mkInstance('b');
  try {
    // Instance A: the app's real migrations + SYNTHETIC data through the
    // app's own stores (test-fixture caller — never production data).
    await migrate(A.pool);
    const clock = systemClock();
    const outboxA = createPostgresOutboxStore({ pool: A.pool, clock });
    const storeA = createPostgresHandoffStore({ pool: A.pool, clock, outbox: outboxA });
    const created = [];
    for (let i = 0; i < 5; i++) {
      const { session } = makeSession();
      await storeA.create(session);
      created.push(session.sessionId);
    }
    const sizeA = await storeA.size();

    // BACKUP: logical dump of every public table (the local stand-in for
    // pg_dump, which is not available on this machine — see runbook).
    let t0 = Date.now();
    const tables = (await A.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )).rows.map((r) => r.tablename);
    const dump = {};
    for (const t of tables) dump[t] = (await A.pool.query(`SELECT * FROM "${t}"`)).rows;
    const backupFile = path.join(dir, 'operational-backup.json');
    fs.writeFileSync(backupFile, JSON.stringify(dump));
    record(`operational backup (logical dump, ${tables.length} tables, ${Object.values(dump).reduce((n, r) => n + r.length, 0)} rows): ${ms(t0)}; size ${fs.statSync(backupFile).size} bytes`);

    // RESTORE into a FRESH instance: schema from the application's own
    // migration path, then data, then sequence repair.
    t0 = Date.now();
    await migrate(B.pool);
    const loaded = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    for (const t of tables) {
      if (/schema_migrations$/.test(t)) continue; // migrate() owns schema history
      for (const row of loaded[t]) {
        const cols = Object.keys(row);
        await B.pool.query(
          `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
          cols.map((c) => row[c]),
        );
      }
      // Sequence repair for identity/serial columns.
      const seqCols = (await B.pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 AND (column_default LIKE 'nextval%' OR is_identity = 'YES')`, [t],
      )).rows.map((r) => r.column_name);
      for (const c of seqCols) {
        await B.pool.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX("${c}") FROM "${t}"), 0) + 1, false)`,
          [t, c],
        );
      }
    }
    record(`operational restore (fresh instance: real migrations + data + sequence repair): ${ms(t0)}`);

    // VERIFY: the application layer reads the restored data.
    t0 = Date.now();
    const outboxB = createPostgresOutboxStore({ pool: B.pool, clock });
    const storeB = createPostgresHandoffStore({ pool: B.pool, clock, outbox: outboxB });
    const sizeB = await storeB.size();
    if (sizeB !== sizeA) throw new Error(`size mismatch after restore: ${sizeB} != ${sizeA}`);
    const recent = await storeB.listRecent('org-a', { limit: 50 });
    if (!created.every((id) => recent.some((s) => s.sessionId === id))) throw new Error('restored sessions not readable');
    // New writes work after restore (sequences repaired).
    const { session: fresh } = makeSession();
    await storeB.create(fresh);
    if ((await storeB.size()) !== sizeA + 1) throw new Error('post-restore write failed');
    record(`operational verify: app store layer reads all ${sizeA} restored sessions and accepts new writes: ${ms(t0)}`);
  } finally {
    await A.stop();
    await B.stop();
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-restore-rehearsal-'));
  const t0 = Date.now();
  try {
    await configStoreRehearsal(dir);
    await operationalStoreRehearsal(dir);
    console.log(`\nREHEARSAL RECORD (${new Date().toISOString()}, total ${ms(t0)}):`);
    for (const line of results) console.log('  - ' + line);
    console.log('RESULT: PASS');
  } catch (e) {
    console.error('RESULT: FAIL —', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
