'use strict';

const http = require('node:http');
const { createApp } = require('./handoff/app');
const { openDatabase } = require('./config/db');
const { migrate: migrateConfig } = require('./config/migrate');
const { createConfigService } = require('./config/service');
const { loadSeedDocument } = require('./config/seed');
const { ConfigError } = require('./config/errors');
const { systemClock } = require('./handoff/clock');
const { createOutboxPoller, DEFAULT_POLL_INTERVAL_MS } = require('./outbox/outbox');

// ---------------------------------------------------------------------------
// SECURITY — STATUS AND REMAINING REQUIREMENT
// Authentication: the GuideHerd Identity Contract (ADR-0009) — service
// surfaces authenticate through the identity middleware and the configured
// provider. Authorization: every route passes the GuideHerd authorization
// boundary (ADR-0010) — GuideHerd-owned permissions, organization scoping,
// capability-token pinning, fail-closed, audited denials. Two routes are
// PUBLIC BY DESIGN via explicit anonymous policy grants (scheduling
// options; handoff creation, contained by the per-organization prepared-
// session cap): the Reception Console has no user login yet. A user-facing
// identity provider and login flow through the Identity Contract remain a
// REQUIRED production milestone before broader exposure (ADR-0010 §6).
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

/** Fail-fast boot error: log loudly, exit non-zero, never bind the port. */
function fatal(message, extra) {
  console.error(JSON.stringify({ level: 'error', message, ...extra }));
  process.exit(1);
}

async function main() {
  // ── Configuration Store (embedded SQLite; unchanged by ADR-0006) ─────────
  // Pending migrations are applied at boot; a missing file starts empty and
  // is populated via `npm run config:seed`. Path override: GUIDEHERD_CONFIG_DB.
  const CONFIG_DB_PATH = process.env.GUIDEHERD_CONFIG_DB || './guideherd-config.db';
  const configDb = openDatabase({ path: CONFIG_DB_PATH });
  const migrationsApplied = migrateConfig(configDb);
  const configService = createConfigService({ db: configDb });

  // Optional seed-on-boot: a "git as source of truth" deployment mode for
  // hosts with an ephemeral or unseeded filesystem (e.g. Railway without a
  // volume). Off by default — opt in per-deployment with GUIDEHERD_SEED_FILE
  // pointing at a config document (see config/data/*.example.json).
  //
  // This re-imports (upserts) the document on every boot, so it MUST NOT be
  // enabled once a firm's configuration is edited through a live channel a
  // git deploy doesn't know about (e.g. a future Administration Portal) —
  // doing so would silently roll live edits back to whatever is in git on the
  // next deploy. Until that exists, git-as-source-of-truth is intentional.
  const SEED_FILE_PATH = process.env.GUIDEHERD_SEED_FILE;
  let seedResult = null;
  if (SEED_FILE_PATH) {
    try {
      const tree = loadSeedDocument(SEED_FILE_PATH);
      seedResult = configService.importOrganization(tree);
    } catch (err) {
      // Fail fast: starting with a partially- or un-seeded store would serve
      // a console that 404s on scheduling-options. Surface the failure loudly
      // (visible in Railway's crash/restart logs) rather than booting broken.
      fatal('Startup seed failed; refusing to start.', {
        seedFile: SEED_FILE_PATH,
        error: err instanceof ConfigError ? err.toBody() : { message: String(err.message || err) },
      });
    }
  }

  // ── Operational Store provider selection (ADR-0006) ──────────────────────
  // GUIDEHERD_OPERATIONAL_PROVIDER:
  //   memory   (default) — in-process sessions, exactly today's live-demo
  //                        behavior; merging PostgreSQL support changes
  //                        nothing until this variable is set explicitly.
  //   postgres           — durable sessions in PostgreSQL (DATABASE_URL or
  //                        GUIDEHERD_OPERATIONAL_DATABASE_URL). Unreachable
  //                        database or failed migration = refuse to start.
  //                        There is NEVER a silent fallback to memory.
  // Rollback is exactly: set the variable back to `memory` and redeploy.
  const OPERATIONAL_PROVIDER = (process.env.GUIDEHERD_OPERATIONAL_PROVIDER || 'memory').trim().toLowerCase();
  let handoffStore; // undefined -> createApp uses the in-memory default
  let notificationDeliveryStore; // undefined -> in-memory default (ADR-0011)
  let integrationDeliveryStore; // undefined -> in-memory default (ADR-0020)
  let outboxStore; // undefined -> in-memory default (ADR-0017)
  let scheduledActionStore; // undefined -> in-memory default (ADR-0018)
  let operationalMigrationsApplied = null;
  if (OPERATIONAL_PROVIDER === 'postgres') {
    const { createOperationalPool } = require('./operational/db');
    const { migrate: migrateOperational } = require('./operational/migrate');
    const { createPostgresHandoffStore } = require('./operational/session-repository');
    const { createPostgresNotificationDeliveryStore } = require('./operational/notification-deliveries');
    const { createPostgresIntegrationDeliveryStore } = require('./operational/integration-deliveries');
    const { createPostgresOutboxStore } = require('./operational/outbox-store');
    const { createPostgresScheduledActionStore } = require('./operational/scheduled-actions');
    try {
      const pool = createOperationalPool();
      operationalMigrationsApplied = await migrateOperational(pool);
      outboxStore = createPostgresOutboxStore({ pool, clock: systemClock() });
      scheduledActionStore = createPostgresScheduledActionStore({ pool, clock: systemClock() });
      handoffStore = createPostgresHandoffStore({ pool, clock: systemClock(), outbox: outboxStore });
      notificationDeliveryStore = createPostgresNotificationDeliveryStore({ pool, clock: systemClock() });
      integrationDeliveryStore = createPostgresIntegrationDeliveryStore({ pool, clock: systemClock() });
    } catch (err) {
      fatal('Operational Store (postgres) is unavailable; refusing to start.', {
        error: { message: String(err.message || err) },
      });
    }
  } else if (OPERATIONAL_PROVIDER !== 'memory') {
    // An unknown value must never silently mean "memory".
    fatal(`Unknown GUIDEHERD_OPERATIONAL_PROVIDER "${OPERATIONAL_PROVIDER}" (expected "memory" or "postgres").`);
  }

  // Browser origins are allowlisted via CORS_ALLOWED_ORIGINS (comma-separated).
  // Defaults to https://guideherd.ai and http://localhost:8080. Never `*`.
  const app = createApp({ configService, configDb, handoffStore, notificationDeliveryStore, integrationDeliveryStore, outboxStore, scheduledActionStore });
  const { handler } = app;
  const server = http.createServer(handler);

  // Restart recovery (ADR-0017/ADR-0018): process anything left pending
  // by a previous instance — durable events AND due scheduled actions —
  // before/while serving traffic.
  app.outbox.drain().catch(() => {});
  app.scheduler.drain().catch(() => {});

  // Liveness (ADR-0017 §3): post-commit nudges give low latency; ONE
  // poller guarantees EVENTUAL processing for both the outbox and the
  // scheduler — pending retries, stale claims, and newly-due scheduled
  // actions all progress without new traffic or a restart. Safe with
  // multiple API instances via the stores' atomic claims.
  const RAW_POLL_INTERVAL = process.env.GUIDEHERD_OUTBOX_POLL_INTERVAL_MS;
  const OUTBOX_POLL_INTERVAL_MS = RAW_POLL_INTERVAL === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(RAW_POLL_INTERVAL);
  if (!Number.isFinite(OUTBOX_POLL_INTERVAL_MS) || OUTBOX_POLL_INTERVAL_MS <= 0) {
    fatal(`Invalid GUIDEHERD_OUTBOX_POLL_INTERVAL_MS "${RAW_POLL_INTERVAL}" (expected a positive number of milliseconds).`);
  }
  const outboxPoller = createOutboxPoller({
    outbox: { drain: () => Promise.all([app.outbox.drain(), app.scheduler.drain()]) },
    intervalMs: OUTBOX_POLL_INTERVAL_MS,
  });
  server.on('close', () => outboxPoller.stop());

  server.listen(PORT, HOST, () => {
    outboxPoller.start(); // after successful boot: the port is bound
    console.log(JSON.stringify({
      level: 'info',
      message: `GuideHerd Context Handoff API listening on ${HOST}:${PORT}`,
      configDb: CONFIG_DB_PATH,
      configMigrationsApplied: migrationsApplied,
      seedFile: SEED_FILE_PATH || null,
      seeded: seedResult ? { organization: seedResult.organization, counts: seedResult.counts } : null,
      operationalProvider: OPERATIONAL_PROVIDER,
      operationalMigrationsApplied,
      outboxPollIntervalMs: OUTBOX_POLL_INTERVAL_MS,
    }));
  });

  return server;
}

const serverPromise = main().catch((err) => {
  fatal('Startup failed.', { error: { message: String(err && err.message) } });
});

module.exports = { serverPromise };
