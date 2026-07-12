'use strict';

const http = require('node:http');
const { createApp } = require('./handoff/app');

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

// Browser origins are allowlisted via CORS_ALLOWED_ORIGINS (comma-separated).
// Defaults to https://guideherd.ai and http://localhost:8080. Never `*`.
const { handler } = createApp();
const server = http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    level: 'info',
    message: `GuideHerd Context Handoff API listening on ${HOST}:${PORT}`,
  }));
});

module.exports = { server };
