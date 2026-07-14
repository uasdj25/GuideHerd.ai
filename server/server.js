'use strict';

const http = require('node:http');
const { createApp } = require('./handoff/app');
const { openDatabase } = require('./config/db');
const { migrate } = require('./config/migrate');
const { createConfigService } = require('./config/service');

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
  }));
});

module.exports = { server };
