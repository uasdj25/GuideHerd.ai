'use strict';

const { systemClock } = require('./clock');
const { createInMemoryHandoffStore } = require('./store');
const { createHandoffService } = require('./service');
const { normalizeCreate, normalizeRedeem } = require('./validation');
const { DEMO_FIRM_ID } = require('./demo-bridge');
const { buildConsultationSummary, renderSummaryHtml } = require('./summary');
const { NoCompletedSummaryError } = require('./errors');
const { createMailer } = require('./mailer');
const { HandoffError, MalformedRequestError, UnauthorizedError, BridgeNotConfiguredError } = require('./errors');
const { ConfigError } = require('../config/errors');
const { IdentityError, IdentityNotConfiguredError } = require('../identity/errors');
const { createIdentityProviderRegistry } = require('../identity/contract');
const { createStaticTokenProvider } = require('../identity/static-token-provider');
const { createIdentityService } = require('../identity/middleware');
const { createAuthorization } = require('../identity/authorization');
const { getSchedulingOptions } = require('../config/options');
const { ConnectError } = require('../connect/errors');
const { createAdapterRegistry } = require('../connect/adapter');
const { createElevenLabsAdapter } = require('../connect/elevenlabs-adapter');
const { createConversationService } = require('../connect/conversations');
const { createConversationEvents } = require('../connect/events');
const { resolveProviderKey } = require('../connect/provider-config');

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
 * @param {{ clock?: import('./clock').Clock, ttlSeconds?: number, corsAllowedOrigins?: string,
 *           configService?: ReturnType<typeof import('../config/service').createConfigService> }} [deps]
 */
function createApp({ clock = systemClock(), ttlSeconds, corsAllowedOrigins, mailer, demoBridgeSecret, configService, handoffStore, staticIdentitiesJson, maxPreparedSessions, authorization } = {}) {
  // Operational Store (ADR-0006): the handoff repository is injectable. The
  // in-memory implementation remains the default; server.js selects the
  // durable PostgreSQL implementation via GUIDEHERD_OPERATIONAL_PROVIDER.
  const store = handoffStore || createInMemoryHandoffStore({ clock });
  // Abuse containment for the deliberately-anonymous create route
  // (ADR-0010): cap concurrently prepared (awaiting-transfer, unexpired)
  // sessions per organization. Enforced ATOMICALLY inside the repository —
  // one synchronous pass in memory; a per-organization advisory
  // transaction lock in PostgreSQL — so concurrent creates across any
  // number of API instances can never overshoot the cap.
  const preparedSessionCap = maxPreparedSessions !== undefined
    ? maxPreparedSessions
    : Number(process.env.GUIDEHERD_MAX_PREPARED_SESSIONS || 20);
  const service = createHandoffService({ store, clock, ttlSeconds, maxPreparedSessions: preparedSessionCap });
  const allowedOrigins = parseAllowedOrigins(
    corsAllowedOrigins !== undefined ? corsAllowedOrigins : process.env.CORS_ALLOWED_ORIGINS,
  );
  // GuideHerd Connect: the provider-neutral conversation layer. The
  // registry holds one Conversation Adapter per provider; the active
  // provider per firm is resolved from the Configuration Store (defaulting
  // to elevenlabs, today's working integration).
  const adapters = createAdapterRegistry();
  adapters.register(createElevenLabsAdapter());
  const events = createConversationEvents();

  // GuideHerd Identity (ADR-0009): authentication happens ONLY through the
  // identity middleware and the provider selected by configuration. The
  // demo bridge secret is absorbed by the StaticTokenProvider as the
  // scheduling-assistant service identity — same credential, same external
  // behavior, but no route inspects it anymore. Malformed identity
  // configuration throws here: the app refuses to compose, never half-works.
  const resolvedBridgeSecret = demoBridgeSecret !== undefined ? demoBridgeSecret : process.env.DEMO_BRIDGE_SECRET;
  const identityProviders = createIdentityProviderRegistry();
  identityProviders.register(createStaticTokenProvider({
    staticIdentitiesJson: staticIdentitiesJson !== undefined ? staticIdentitiesJson : process.env.GUIDEHERD_STATIC_IDENTITIES,
    demoBridgeSecret: resolvedBridgeSecret,
  }));
  const identityService = createIdentityService({
    registry: identityProviders,
    configService: configService || null,
  });

  // GuideHerd Authorization (ADR-0010): the single decision point for "may
  // this principal perform this operation, in this organization, on this
  // resource?" Routes express GuideHerd permissions; the policy inside the
  // authorization service decides. Injectable only for tests.
  const authz = authorization || createAuthorization();

  const deps = {
    service,
    store,
    allowedOrigins,
    // Mailer is injectable so automated tests never touch Microsoft endpoints.
    mailer: mailer || createMailer(),
    // Configuration Store service (read-only use here). Optional: when
    // absent, configuration endpoints answer 503 rather than failing boot.
    configService: configService || null,
    adapters,
    identityService,
    authz,
  };
  deps.conversations = createConversationService({
    service, store, mailer: deps.mailer, events, clock,
  });
  const handler = makeHandler(deps);
  return {
    handler, store, service, clock, allowedOrigins,
    mailer: deps.mailer, events, adapters, conversations: deps.conversations,
    identity: { registry: identityProviders, service: identityService },
    authorization: authz,
  };
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
function makeHandler({ service, store, allowedOrigins, mailer, configService, adapters, conversations, identityService, authz }) {
  /**
   * Resolve the active Conversation Adapter for a firm. Provider selection
   * comes from the Configuration Store (connect/conversation-provider),
   * defaulting to today's integration when unset; an explicitly configured
   * but unregistered provider fails loudly (503).
   */
  const adapterFor = (firmId) => adapters.resolve(resolveProviderKey(configService, firmId));

  /**
   * Authenticate a demo-bridge request through the Identity Contract and
   * authorize the named GuideHerd permission for the demo organization
   * (ADR-0010): the route states its intent; the policy decides. Routes
   * never see the bearer token — only the resulting GuideHerdIdentity.
   *
   * TEMPORARY DEMO INFRASTRUCTURE dialect: the bridge's documented
   * "not configured" error code predates the Identity Contract and is
   * preserved verbatim while the bridge exists; the mapping dies with it.
   */
  const authorizeAssistant = async (req, permission) => {
    let identity;
    try {
      identity = await identityService.authenticate(req, { organizationKey: DEMO_FIRM_ID });
    } catch (err) {
      if (err instanceof IdentityNotConfiguredError) throw new BridgeNotConfiguredError();
      throw err;
    }
    authz.authorize({ identity }, permission, {
      organizationKey: DEMO_FIRM_ID,
      auditSuccess: true, // privileged, low-frequency service operations
    });
    return identity;
  };

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

      // Scheduling options for the GuideHerd Console: the firm's practice
      // areas and, per practice area, the attorneys its routing groups reach.
      // Read-only, browser-facing (same CORS posture as the handoff routes),
      // and served from the Configuration Store.
      const optionsMatch = path.match(/^\/api\/v1\/firms\/([^/]+)\/scheduling-options$/);
      if (optionsMatch && method === 'GET') {
        if (!configService) {
          status = 503;
          return sendJson(res, status, {
            error: { code: 'config_unavailable', message: 'The configuration store is not available.' },
          }, cors);
        }
        const firmId = decodeURIComponent(optionsMatch[1]);
        // PUBLIC BY DESIGN (ADR-0010): the console renders this without a
        // login. The anonymous grant is declared centrally in the policy —
        // this route is intentionally, not accidentally, anonymous.
        authz.authorize({ anonymous: true }, 'configuration:read', { organizationKey: firmId });
        const options = getSchedulingOptions(configService, firmId);
        status = 200;
        return sendJson(res, status, options, cors);
      }

      if (method === 'POST' && path === '/api/v1/handoffs') {
        const body = await readJsonBody(req);
        const request = normalizeCreate(body);
        // PUBLIC BY DESIGN until a user-facing identity provider arrives
        // (ADR-0010 records the deferral): the anonymous grant is declared
        // centrally in the policy. The per-organization prepared-session
        // cap that contains anonymous abuse is enforced ATOMICALLY inside
        // the repository via service.create (429 when full).
        authz.authorize({ anonymous: true }, 'handoff:create', { organizationKey: request.firmId });
        const { response } = await service.create(request);
        sessionId = response.sessionId;
        status = 201;
        return sendJson(res, status, response, cors);
      }

      if (method === 'POST' && path === '/api/v1/handoffs/redeem') {
        const body = await readJsonBody(req);
        const { handoffToken } = normalizeRedeem(body);
        const context = await service.redeem(handoffToken); // repository verifies the capability credential
        // Capability authorization (ADR-0010): a handoff token may redeem
        // exactly its own session, and nothing else.
        authz.authorize(
          { capability: { type: 'handoff-token', sessionId: context.sessionId } },
          'handoff:redeem',
          { resource: { type: 'handoff-session', id: context.sessionId } },
        );
        sessionId = context.sessionId;
        status = 200;
        return sendJson(res, status, context, cors);
      }

      // ── TEMPORARY DEMO INFRASTRUCTURE (Slice 3) ─────────────────────
      // Server-held bridge for the controlled demonstration. Authorized by
      // DEMO_BRIDGE_SECRET via Authorization: Bearer only. No browser CORS.
      // The demo ROUTES are temporary; the GuideHerd Connect conversation
      // layer they delegate to is not.
      if (method === 'POST' && path === '/api/v1/demo/connect') {
        await authorizeAssistant(req, 'conversation:connect');
        const adapter = adapterFor(DEMO_FIRM_ID);
        // The request body is OPTIONAL and read leniently (size-capped;
        // unparseable bodies become undefined rather than 400): provider
        // dialects — a webhook UI that requires at least one JSON property,
        // or one that carries correlation metadata — are entirely the
        // adapter's concern. The adapter translates the dialect into a
        // neutral ConnectIntent; the Correlation Engine does the matching.
        const rawBody = await readJsonBodyLenient(req);
        const intent = adapter.translateConnect(rawBody);
        const context = await conversations.connect(DEMO_FIRM_ID, adapter.providerKey, intent);
        sessionId = context.sessionId;
        status = 200;
        return sendJson(res, status, context, null);
      }

      // TEMPORARY DEMO INFRASTRUCTURE: operator view of the latest completed
      // Consultation Summary, for demos where Microsoft Graph is not yet
      // configured. Bridge-secret authorized; the Graph mailer is untouched.
      if (method === 'GET' && path === '/api/v1/demo/summary/latest') {
        await authorizeAssistant(req, 'summary:read');
        const session = await store.latestCompleted(DEMO_FIRM_ID);
        if (!session) throw new NoCompletedSummaryError();
        sessionId = session.sessionId;
        status = 200;
        const html = renderSummaryHtml(buildConsultationSummary(session));
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      }

      if (method === 'POST' && path === '/api/v1/demo/outcome') {
        await authorizeAssistant(req, 'conversation:complete');
        const adapter = adapterFor(DEMO_FIRM_ID);
        const body = await readJsonBody(req);
        // The adapter translates the provider's dialect into the canonical
        // outcome contract; validation is shared and provider-independent.
        const { sessionId: outcomeSessionId, outcome } = adapter.translateOutcome(body);
        const result = await conversations.complete(outcomeSessionId, outcome, adapter.providerKey);
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

        // Capability authorization (ADR-0010): a console token permits
        // status reads and cancellation on exactly its own session. The
        // repository verifies the credential itself (constant-time hash,
        // 403 on mismatch); this pins WHICH operations the capability may
        // perform. No success audit: status is high-frequency polling.
        const consoleCapability = { capability: { type: 'console-token', sessionId } };
        const sessionResource = { resource: { type: 'handoff-session', id: sessionId } };

        if (method === 'GET') {
          authz.authorize(consoleCapability, 'handoff:read', sessionResource);
          const statusBody = await service.status(sessionId, consoleToken);
          status = 200;
          return sendJson(res, status, statusBody, cors);
        }
        authz.authorize(consoleCapability, 'handoff:cancel', sessionResource);
        const cancelBody = await service.cancel(sessionId, consoleToken);
        status = 200;
        return sendJson(res, status, cancelBody, cors);
      }

      status = 404;
      return sendJson(res, status, { error: { code: 'not_found', message: 'Resource not found.' } }, cors);
    } catch (err) {
      if (err instanceof HandoffError || err instanceof ConfigError || err instanceof ConnectError || err instanceof IdentityError) {
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

/**
 * Read a request body leniently, enforcing the size cap: valid JSON parses,
 * while an empty or unparseable body resolves to undefined instead of
 * rejecting. Used where the body is optional provider ceremony whose
 * interpretation belongs entirely to the Conversation Adapter.
 */
function readJsonBodyLenient(req) {
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
      if (raw === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined); // tolerated: dialect hygiene is the adapter's concern
      }
    });
    req.on('error', () => resolve(undefined)); // discarded anyway
  });
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
