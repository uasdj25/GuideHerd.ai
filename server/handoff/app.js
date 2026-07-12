'use strict';

const { systemClock } = require('./clock');
const { createInMemoryHandoffStore } = require('./store');
const { createHandoffService } = require('./service');
const { normalizeCreate, normalizeRedeem } = require('./validation');
const { HandoffError, MalformedRequestError } = require('./errors');

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
function createApp({ clock = systemClock(), ttlSeconds, corsAllowedOrigins } = {}) {
  const store = createInMemoryHandoffStore({ clock });
  const service = createHandoffService({ store, clock, ttlSeconds });
  const allowedOrigins = parseAllowedOrigins(
    corsAllowedOrigins !== undefined ? corsAllowedOrigins : process.env.CORS_ALLOWED_ORIGINS,
  );
  const handler = makeHandler(service, allowedOrigins);
  return { handler, store, service, clock, allowedOrigins };
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

/** Build the raw Node http request handler for the two routes. */
function makeHandler(service, allowedOrigins) {
  return async function handle(req, res) {
    const startedAt = Date.now();
    let status = 500;
    let sessionId; // captured for logging only — never a token
    const cors = corsHeadersFor(req, allowedOrigins);

    try {
      const method = req.method;
      // Parse path only; tokens are never read from the query string.
      const path = new URL(req.url, 'http://localhost').pathname;

      // Preflight. Only POST (plus OPTIONS itself) and Content-Type are allowed.
      if (method === 'OPTIONS') {
        status = 204;
        const headers = cors
          ? {
              ...cors,
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
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
