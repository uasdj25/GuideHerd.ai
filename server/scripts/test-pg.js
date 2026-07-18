'use strict';

/**
 * PostgreSQL test harness — runs the backend suite's PostgreSQL leg against
 * a REAL, disposable, embedded PostgreSQL instance (ADR-0006 discipline:
 * the contract suites must run on the real engine, not an emulator).
 *
 *   npm run test:pg
 *
 * Guarantees:
 *   - development-only: embedded-postgres is a devDependency (exact-pinned);
 *     nothing here is reachable from production composition
 *   - isolated: a fresh temporary data directory and database per run,
 *     removed afterwards
 *   - local-only: binds 127.0.0.1 on an OS-allocated free port
 *   - credentialless output: the superuser password is random,
 *     process-local, and never printed, logged, or written anywhere except
 *     the child's environment; this script prints status lines only
 *   - real migration path: the suite itself applies
 *     server/operational/migrate.js migrations, exactly as production does
 *   - always cleaned up: stop + remove on success, failure, SIGINT,
 *     SIGTERM, or timeout
 *
 * The normal `npm test` remains fast and PostgreSQL-free; the PostgreSQL
 * leg is opt-in via this script (or an externally supplied
 * GUIDEHERD_TEST_DATABASE_URL, e.g. in CI).
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const EmbeddedPostgresModule = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;

const SUITE_TIMEOUT_MS = 10 * 60 * 1000; // hard stop: never leave a postgres behind
const DB_NAME = 'guideherd_test';

/** An OS-allocated free localhost port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-pg-'));
  const port = await freePort();
  // Process-local credential for a loopback-only, throwaway instance.
  // Never printed; exists only here and in the child's environment.
  const password = crypto.randomBytes(24).toString('base64url');

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'guideherd',
    password,
    port,
    persistent: false,
  });

  let stopped = false;
  let exitCode = 1;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try { await pg.stop(); } catch { /* already down */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const bail = (signal) => {
    console.error(`[test:pg] ${signal} — stopping embedded PostgreSQL and cleaning up`);
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', () => bail('SIGINT'));
  process.on('SIGTERM', () => bail('SIGTERM'));

  try {
    console.log('[test:pg] initialising a disposable PostgreSQL (temp data dir, 127.0.0.1, random local credential)');
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(DB_NAME);
    console.log('[test:pg] up — running the full backend suite with the PostgreSQL leg enabled');

    const child = spawn(process.execPath, ['--experimental-sqlite', '--test'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        // The suite's standard opt-in; the URL exists only in the child's
        // environment and is never echoed by this script.
        GUIDEHERD_TEST_DATABASE_URL: `postgresql://guideherd:${password}@127.0.0.1:${port}/${DB_NAME}`,
      },
    });

    exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error('[test:pg] suite timeout — killing the test run');
        child.kill('SIGKILL');
        resolve(124);
      }, SUITE_TIMEOUT_MS);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    });
  } finally {
    await cleanup();
    console.log('[test:pg] embedded PostgreSQL stopped; temporary state removed');
  }
  process.exit(exitCode);
}

main().catch(async (err) => {
  // Never print connection strings; surface the message only.
  console.error(`[test:pg] failed: ${String(err && err.message ? err.message : err)}`);
  process.exit(1);
});
