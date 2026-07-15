'use strict';

const http = require('node:http');
const { createApp } = require('./handoff/app');
const { openDatabase } = require('./config/db');
const { migrate } = require('./config/migrate');
const { createConfigService } = require('./config/service');
const { loadSeedDocument } = require('./config/seed');
const { ConfigError } = require('./config/errors');

// ---------------------------------------------------------------------------
// SECURITY — PRODUCTION REQUIREMENT
// These endpoints are UNAUTHENTICATED in v1. Before any production deployment,
// the Context Handoff API MUST sit behind authentication and authorization
// (e.g. service-to-service credentials for the GuideHerd Console and the
// Scheduling Assistant, plus network-level restrictions). Do not expose these
// routes publicly as-is.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

// Configuration Store: an embedded SQLite file opened in-process (SQLite is
// a library, not a server — nothing separate runs). Pending migrations are
// applied at boot; a missing file starts empty and is populated via
// `npm run config:seed`. Path override: GUIDEHERD_CONFIG_DB.
const CONFIG_DB_PATH = process.env.GUIDEHERD_CONFIG_DB || './guideherd-config.db';
const configDb = openDatabase({ path: CONFIG_DB_PATH });
const migrationsApplied = migrate(configDb);
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
    console.error(JSON.stringify({
      level: 'error',
      message: 'Startup seed failed; refusing to start.',
      seedFile: SEED_FILE_PATH,
      error: err instanceof ConfigError ? err.toBody() : { message: String(err.message || err) },
    }));
    process.exit(1);
  }
}

// Browser origins are allowlisted via CORS_ALLOWED_ORIGINS (comma-separated).
// Defaults to https://guideherd.ai and http://localhost:8080. Never `*`.
const { handler } = createApp({ configService });
const server = http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    level: 'info',
    message: `GuideHerd Context Handoff API listening on ${HOST}:${PORT}`,
    configDb: CONFIG_DB_PATH,
    configMigrationsApplied: migrationsApplied,
    seedFile: SEED_FILE_PATH || null,
    seeded: seedResult ? { organization: seedResult.organization, counts: seedResult.counts } : null,
  }));
});

module.exports = { server };
