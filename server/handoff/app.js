'use strict';

const { systemClock } = require('./clock');
const { createInMemoryHandoffStore } = require('./store');
const { createHandoffService } = require('./service');
const { normalizeCreate, normalizeRedeem } = require('./validation');
const { requireBridgeAuth, normalizeOutcome, recordOutcomeAndDeliver, DEMO_FIRM_ID } = require('./demo-bridge');
const { createMailer } = require('./mailer');
const { HandoffError, MalformedRequestError, UnauthorizedError } = require('./errors');

// Scheduling context is tiny; cap the body to reject oversized payloads early.
const MAX_BODY_BYTES = 16 * 1024;

// Browser callers must be explicitly allowlisted. No wildcard is ever honored.
const DEFAULT_CORS_ALLOWED_ORIGINS = ['https://guideherd.ai', 'http://localhost:8080'];

/**
 * Parse a comma-separated origin allowlist (CORS_ALLOWED_ORIGINS). Wildcard
 * entries are dropped: this API never allows `*`.
 * @param {string|undefined} raw
 * @returns {Set<string>}
 */
function parseAllowedOrigins(raw) {
  const entries = (raw === undefined || raw.trim() === '')
    ? DEFAULT_CORS_ALLOWED_ORIGINS
    : raw.split(',');
  const origins = entries
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o !== '' && o !== '*');
  return new Set(origins);
}

/**
 * Compose the application (store + service + HTTP handler) with injectable
 * dependencies so tests can supply a deterministic clock, TTL, and origins.
 *
 * @param {{ clock?: import('./clock').Clock, ttlSeconds?: number, corsAllowedOrigins?: string }} [deps]
 */
function createApp({ clock = systemClock(), ttlSeconds, corsAllowedOrigins, mailer, demoBridgeSecret } = {}) {
  const store = createInMemoryHandoffStore({ clock });
  const service = createHandoffService({ store, clock, ttlSeconds });
  const allowedOrigins = parseAllowedOrigins(
    corsAllowedOrigins !== undefined ? corsAllowedOrigins : process.env.CORS_ALLOWED_ORIGINS,
  );
  const deps = {
    service,
    store,
    allowedOrigins,
    // Mailer is injectable so automated tests never touch Microsoft endpoints.
    mailer: mailer || createMailer(),
    // TEMPORARY DEMO INFRASTRUCTURE — see demo-bridge.js.
    demoBridgeSecret: demoBridgeSecret !== undefined ? demoBridgeSecret : process.env.DEMO_BRIDGE_SECRET,
  };
  const handler = makeHandler(deps);
  return { handler, store, service, clock, allowedOrigins, mailer: deps.mailer };
}

/**
 * CORS response headers for a request, or null when the Origin is absent or
 * not allowlisted (no CORS headers → the browser blocks the response).
 * @param {import('node:http').IncomingMessage} req
 * @param {Set<string>} allowedOrigins
 */
function corsHeadersFor(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin.replace(/\/$/, ''))) {
    return null;
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
}

/** Build the raw Node http request handler. */
function makeHandler({ service, store, allowedOrigins, mailer, demoBridgeSecret }) {
  return async function handle(req, res) {
    const startedAt = Date.now();
    let status = 500;
    let sessionId; // captured for logging only — never a token or secret
    // Demo bridge endpoints are server-to-server only: they are never
    // granted browser CORS headers, regardless of Origin.
    const isDemoPath = typeof req.url === 'string' && req.url.startsWith('/api/v1/demo/');
    const cors = isDemoPath ? null : corsHeadersFor(req, allowedOrigins);

    try {
      const method = req.method;
      // Parse path only; tokens are never read from the query string.
      const path = new URL(req.url, 'http://localhost').pathname;

      // Preflight. Allowed: POST/GET/DELETE (+ OPTIONS), Content-Type and Authorization.
      if (method === 'OPTIONS') {
        status = 204;
        const headers = cors
          ? {
              ...cors,
              'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
              'Access-Control-Max-Age': '600',
            }
          : { 'Vary': 'Origin' };
        res.writeHead(status, headers);
        return res.end();
      }

      if (method === 'POST' && path === '/api/v1/handoffs') {
        const body = await readJsonBody(req);
        const request = normalizeCreate(body);
        const { response } = service.create(request);
        sessionId = response.sessionId;
        status = 201;
        return sendJson(res, status, response, cors);
      }

      if (method === 'POST' && path === '/api/v1/handoffs/redeem') {
        const body = await readJsonBody(req);
        const { handoffToken } = normalizeRedeem(body);
        const context = service.redeem(handoffToken);
        sessionId = context.sessionId;
        status = 200;
        return sendJson(res, status, context, cors);
      }

      // ── TEMPORARY DEMO INFRASTRUCTURE (Slice 3) ─────────────────────
      // Server-held bridge for the controlled demonstration. Authorized by
      // DEMO_BRIDGE_SECRET via Authorization: Bearer only. No browser CORS.
      if (method === 'POST' && path === '/api/v1/demo/connect') {
        requireBridgeAuth(demoBridgeSecret, req.headers.authorization);
        const context = service.connectDemo(DEMO_FIRM_ID);
        sessionId = context.sessionId;
        status = 200;
        return sendJson(res, status, context, null);
      }

      if (method === 'POST' && path === '/api/v1/demo/outcome') {
        requireBridgeAuth(demoBridgeSecret, req.headers.authorization);
        const body = await readJsonBody(req);
        const { sessionId: outcomeSessionId, outcome } = normalizeOutcome(body);
        const result = await recordOutcomeAndDeliver({ service, store, mailer }, outcomeSessionId, outcome);
        sessionId = result.sessionId;
        status = 200;
        return sendJson(res, status, result, null);
      }

      // Console operations: GET (status) / DELETE (cancel) on a session,
      // authorized by the console bearer token. Tokens are read only from the
      // Authorization header — never from the URL.
      const sessionMatch = path.match(/^\/api\/v1\/handoffs\/([^/]+)$/);
      if (sessionMatch && sessionMatch[1] !== 'redeem' && (method === 'GET' || method === 'DELETE')) {
        const consoleToken = readBearerToken(req); // throws 401 if missing/malformed
        sessionId = sessionMatch[1];

        if (method === 'GET') {
          const statusBody = service.status(sessionId, consoleToken);
          status = 200;
          return sendJson(res, status, statusBody, cors);
        }
        const cancelBody = service.cancel(sessionId, consoleToken);
        status = 200;
        return sendJson(res, status, cancelBody, cors);
      }

      status = 404;
      return sendJson(res, status, { error: { code: 'not_found', message: 'Resource not found.' } }, cors);
    } catch (err) {
      if (err instanceof HandoffError) {
        status = err.status;
        return sendJson(res, status, err.toBody(), cors);
      }
      // Never leak internal details (which could include token material).
      status = 500;
      return sendJson(res, status, {
        error: { code: 'internal_error', message: 'An unexpected error occurred.' },
      }, cors);
    } finally {
      logRequest(req, status, sessionId, Date.now() - startedAt);
    }
  };
}

/**
 * Extract a bearer token from the Authorization header.
 * Throws 401 when the header is missing or malformed. The raw token is never
 * logged and never appears in error messages.
 */
function readBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') throw new UnauthorizedError();
  const match = header.match(/^Bearer\s+(\S+)$/);
  if (!match) throw new UnauthorizedError();
  return match[1];
}

/** Read and JSON-parse a request body, enforcing the size cap. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new MalformedRequestError('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new MalformedRequestError());
      }
    });
    req.on('error', () => reject(new MalformedRequestError()));
  });
}

function sendJson(res, status, body, cors) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(cors || {}),
  });
  res.end(JSON.stringify(body));
}

/** Structured request log. Tokens are NEVER logged; only the sessionId is. */
function logRequest(req, status, sessionId, durationMs) {
  const path = typeof req.url === 'string' ? req.url.split('?')[0] : req.url;
  console.log(JSON.stringify({
    level: 'info',
    method: req.method,
    path,
    status,
    sessionId: sessionId ?? null,
    durationMs,
  }));
}

module.exports = { createApp, MAX_BODY_BYTES };
