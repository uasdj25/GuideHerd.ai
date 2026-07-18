'use strict';

/**
 * GuideHerd User Session tests (ADR-0013).
 *
 * Covers the session service (establish/validate/expire/invalidate/
 * rotate), the dev user provider, the login/logout/session HTTP flow,
 * cookie attributes, protected-console enforcement, cross-organization
 * isolation, provider replacement and unavailability, and the guarantee
 * that service authentication and capability-token workflows are
 * untouched. Deterministic: fixed clocks, no external infrastructure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createTelemetry } = require('../telemetry/telemetry');
const { createUserSessionService, SESSION_TOKEN_PREFIX, DEFAULT_SESSION_TTL_SECONDS } = require('./user-sessions');
const { createDevUserProvider } = require('./dev-user-provider');
const { createUserAuthProviderRegistry, resolveUserAuthProviderKey } = require('./user-auth');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';
const JANE_KEY = 'dev-key-jane-0123456789abcdef';
const DEV_USERS = JSON.stringify([
  { key: JANE_KEY, subject: 'jane-doe', displayName: 'Jane Doe', organizationKey: FIRM, roles: ['receptionist'] },
  { key: 'dev-key-omar-0123456789abcdef', subject: 'omar-reyes', displayName: 'Omar Reyes', organizationKey: 'other-firm', roles: ['receptionist'] },
]);

const CLAIM = Object.freeze({
  subject: 'jane-doe', type: 'user', displayName: 'Jane Doe', organizationKey: FIRM, roles: ['receptionist'],
});

// ── Session service ─────────────────────────────────────────────────────────

test('sessions: establish issues opaque prefixed tokens, stores hashes only, and validates round-trip', async () => {
  const clock = fixedClock(T0);
  const sessions = createUserSessionService({ clock });
  const { token, identity, expiresAtMs } = await sessions.establish(CLAIM, 'dev-user');

  assert.ok(token.startsWith(SESSION_TOKEN_PREFIX));
  assert.equal(identity.provider, 'dev-user', 'provenance stamped by the contract');
  assert.equal(expiresAtMs, T0 + DEFAULT_SESSION_TTL_SECONDS * 1000);

  const validated = await sessions.validate(token);
  assert.equal(validated.identity.subject, 'jane-doe');
  assert.ok(Object.isFrozen(validated.identity), 'sessions hold the frozen validated identity');

  assert.equal(await sessions.validate('gh_usession_forged'), null, 'unknown tokens are null');
  assert.equal(await sessions.validate('other-shape-token'), null);
  assert.equal(await sessions.validate(undefined), null);
});

test('sessions: expiration is absolute and lazy; invalidation is immediate; service identities never get sessions', async () => {
  const clock = fixedClock(T0);
  const sessions = createUserSessionService({ clock, ttlSeconds: 3600 });
  const { token } = await sessions.establish(CLAIM, 'dev-user');

  clock.set(T0 + 3600 * 1000 - 1);
  assert.ok(await sessions.validate(token), 'valid until the last ms');
  clock.set(T0 + 3600 * 1000);
  assert.equal(await sessions.validate(token), null, 'expired exactly at TTL');

  clock.set(T0);
  const second = await sessions.establish(CLAIM, 'dev-user');
  await sessions.invalidate(second.token);
  assert.equal(await sessions.validate(second.token), null, 'invalidated immediately');

  await assert.rejects(
    () => sessions.establish({ ...CLAIM, type: 'service' }, 'dev-user'),
    (e) => e.status === 401,
    'cookie sessions are for users only',
  );
});

test('sessions: login rotation — a token presented at login is invalidated and a fresh one issued', async () => {
  const clock = fixedClock(T0);
  const sessions = createUserSessionService({ clock });
  const first = await sessions.establish(CLAIM, 'dev-user');
  const second = await sessions.establish(CLAIM, 'dev-user', { presentedToken: first.token });

  assert.notEqual(second.token, first.token, 'always a fresh token');
  assert.equal(await sessions.validate(first.token), null, 'pre-login session cannot survive login (fixation)');
  assert.ok(await sessions.validate(second.token));
});

// ── Dev provider ────────────────────────────────────────────────────────────

test('dev provider: authenticates configured users; wrong/missing credentials and empty config fail closed', async () => {
  const provider = createDevUserProvider({ devUsersJson: DEV_USERS });
  assert.equal(provider.size(), 2);
  const claim = await provider.authenticateUser({ credential: JANE_KEY });
  assert.equal(claim.subject, 'jane-doe');
  assert.equal(claim.type, 'user');

  await assert.rejects(() => provider.authenticateUser({ credential: 'wrong' }), (e) => e.status === 403);
  await assert.rejects(() => provider.authenticateUser({}), (e) => e.status === 403);
  const empty = createDevUserProvider({});
  await assert.rejects(() => empty.authenticateUser({ credential: 'x' }), (e) => e.status === 503);

  assert.throws(() => createDevUserProvider({ devUsersJson: 'not json' }), /not valid JSON/);
  assert.throws(() => createDevUserProvider({ devUsersJson: '[{"key":"short","subject":"x","organizationKey":"o","roles":["r"]}]' }), /at least 16/);
  assert.throws(() => createDevUserProvider({ devUsersJson: '[{"key":"0123456789abcdef","subject":"x","organizationKey":"o"}]' }), /no roles/);
});

test('user-auth: registry resolves providers, fails loudly on unknown; env selects the active provider', () => {
  const registry = createUserAuthProviderRegistry();
  registry.register(createDevUserProvider({ devUsersJson: DEV_USERS }));
  assert.ok(registry.resolve('dev-user'));
  assert.throws(() => registry.resolve('entra'), (e) => e.status === 503 && e.code === 'identity_provider_unavailable');
  assert.throws(() => registry.register({ providerKey: 'x' }), TypeError);

  assert.equal(resolveUserAuthProviderKey({}), 'dev-user');
  assert.equal(resolveUserAuthProviderKey({ GUIDEHERD_USER_AUTH_PROVIDER: 'entra' }), 'entra');
});

// ── HTTP flow ───────────────────────────────────────────────────────────────

function configServiceWithFirms() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: 'America/New_York' });
  return configService;
}

async function withServer(opts, fn) {
  const lines = [];
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    configService: configServiceWithFirms(),
    devUsersJson: DEV_USERS,
    telemetry: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) }),
    ...opts,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app, lines);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Extract the gh_session cookie value from a login response. */
function sessionCookieOf(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/gh_session=([^;]*)/);
  return match ? match[1] : null;
}

function createBody(firmId = FIRM) {
  return {
    firmId,
    caller: { fullName: 'Test Caller', email: 'caller@example.com', phone: '+12565550100' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

test('HTTP: successful login sets a hardened HttpOnly cookie and returns identity facts — never the token', async () => {
  await withServer({}, async (base, app, lines) => {
    const res = await post(base, '/api/v1/auth/login', { credential: JANE_KEY });
    assert.equal(res.status, 200);

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /gh_session=gh_usession_/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      assert.ok(setCookie.includes(attr), `cookie carries ${attr}`);
    }
    assert.equal(/domain=/i.test(setCookie), false, 'HOST-ONLY: the Domain attribute is never set — the cookie binds to the API host exactly, not subdomains');
    const body = await res.json();
    assert.deepEqual(body, {
      subject: 'jane-doe', displayName: 'Jane Doe', organizationKey: FIRM,
      roles: ['receptionist'], expiresAt: '2026-07-12T23:15:00.000Z',
    });
    assert.equal(JSON.stringify(body).includes('gh_usession_'), false, 'token only in the HttpOnly cookie');

    const event = lines.find((l) => l.event === 'guideherd.authentication.login');
    assert.equal(event.subject, 'jane-doe');
    assert.equal(JSON.stringify(lines).includes(JANE_KEY), false, 'credentials never in telemetry');
  });
});

test('HTTP: failed login is a generic 403 with an audit event; unknown org membership is refused', async () => {
  await withServer({}, async (base, app, lines) => {
    const bad = await post(base, '/api/v1/auth/login', { credential: 'wrong-credential-000000' });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error.code, 'forbidden');
    assert.ok(lines.some((l) => l.event === 'guideherd.authentication.login_failed'));

    const missing = await post(base, '/api/v1/auth/login', {});
    assert.equal(missing.status, 400);
  });

  // A provider claim naming an organization GuideHerd does not know is refused.
  const strangerUsers = JSON.stringify([
    { key: 'dev-key-ghost-0123456789ab', subject: 'ghost', organizationKey: 'no-such-org', roles: ['receptionist'] },
  ]);
  await withServer({ devUsersJson: strangerUsers }, async (base) => {
    const res = await post(base, '/api/v1/auth/login', { credential: 'dev-key-ghost-0123456789ab' });
    assert.equal(res.status, 403, 'organization membership is GuideHerd-validated');
  });
});

test('HTTP: session endpoint, logout, expiry, and rotation behave server-side', async () => {
  await withServer({ userSessionTtlSeconds: 3600 }, async (base, app) => {
    const login = await post(base, '/api/v1/auth/login', { credential: JANE_KEY });
    const cookie = sessionCookieOf(login);

    const who = await fetch(`${base}/api/v1/auth/session`, { headers: { cookie: `gh_session=${cookie}` } });
    assert.equal(who.status, 200);
    assert.equal((await who.json()).subject, 'jane-doe');
    assert.equal((await fetch(`${base}/api/v1/auth/session`)).status, 401, 'no cookie: 401');
    assert.equal((await fetch(`${base}/api/v1/auth/session`, { headers: { cookie: 'gh_session=gh_usession_forged' } })).status, 401, 'invalid session: 401');

    // Rotation: logging in again with the old cookie kills it.
    const relogin = await post(base, '/api/v1/auth/login', { credential: JANE_KEY }, { cookie: `gh_session=${cookie}` });
    const fresh = sessionCookieOf(relogin);
    assert.notEqual(fresh, cookie);
    assert.equal((await fetch(`${base}/api/v1/auth/session`, { headers: { cookie: `gh_session=${cookie}` } })).status, 401, 'old session rotated away');

    // Logout invalidates server-side and clears the cookie.
    const logout = await post(base, '/api/v1/auth/logout', {}, { cookie: `gh_session=${fresh}` });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/v1/auth/session`, { headers: { cookie: `gh_session=${fresh}` } })).status, 401);

    // Expiry: a new session dies at its absolute TTL.
    const last = sessionCookieOf(await post(base, '/api/v1/auth/login', { credential: JANE_KEY }));
    app.clock.set(T0 + 3600 * 1000);
    assert.equal((await fetch(`${base}/api/v1/auth/session`, { headers: { cookie: `gh_session=${last}` } })).status, 401, 'expired session: 401');
  });
});

// ── Protected Reception Console ─────────────────────────────────────────────

test('HTTP: with console auth REQUIRED, anonymous console access is rejected and login restores the workflow', async () => {
  await withServer({ consoleAuth: 'required' }, async (base) => {
    // Anonymous rejection: both console operations.
    assert.equal((await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`)).status, 401);
    assert.equal((await post(base, '/api/v1/handoffs', createBody())).status, 401);

    // The receptionist workflow after login: options + create + capability
    // status/cancel — end to end.
    const cookie = sessionCookieOf(await post(base, '/api/v1/auth/login', { credential: JANE_KEY }));
    const auth = { cookie: `gh_session=${cookie}` };

    const options = await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`, { headers: auth });
    assert.equal(options.status, 200);

    const created = await post(base, '/api/v1/handoffs', createBody(), auth);
    assert.equal(created.status, 201);
    const session = await created.json();

    // Capability tokens remain unchanged: status and cancel use the
    // console token, not the user session.
    const statusRes = await fetch(`${base}/api/v1/handoffs/${session.sessionId}`, {
      headers: { authorization: `Bearer ${session.consoleToken}` },
    });
    assert.equal(statusRes.status, 200);
    const cancel = await fetch(`${base}/api/v1/handoffs/${session.sessionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${session.consoleToken}` },
    });
    assert.equal(cancel.status, 200);
  });
});

test('HTTP: cross-organization isolation — a receptionist cannot act on another firm', async () => {
  await withServer({ consoleAuth: 'required' }, async (base) => {
    const cookie = sessionCookieOf(await post(base, '/api/v1/auth/login', { credential: JANE_KEY }));
    const auth = { cookie: `gh_session=${cookie}` };

    // The body's firmId is untrusted input checked against the session.
    const cross = await post(base, '/api/v1/handoffs', createBody('other-firm'), auth);
    assert.equal(cross.status, 403, 'creating for another organization is structurally rejected');

    const crossOptions = await fetch(`${base}/api/v1/firms/other-firm/scheduling-options`, { headers: auth });
    assert.equal(crossOptions.status, 403, 'reading another organization\'s configuration is rejected');
  });
});

test('HTTP: default mode is unchanged — anonymous console still works, sessions are additive', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`)).status, 200);
    assert.equal((await post(base, '/api/v1/handoffs', createBody())).status, 201);
  });
});

test('HTTP: an unknown console-auth mode refuses to compose the app', () => {
  assert.throws(() => createApp({ consoleAuth: 'maybe' }), /Unknown GUIDEHERD_CONSOLE_AUTH/);
});

// ── Provider independence ───────────────────────────────────────────────────

test('HTTP: the active provider is configuration — replacement requires no Core change; unavailable providers fail loudly', async () => {
  await withServer({ userAuthProviderKey: 'test-idp' }, async (base, app) => {
    // Unregistered configured provider: loud 503, fail closed.
    const before = await post(base, '/api/v1/auth/login', { credential: 'anything' });
    assert.equal(before.status, 503);
    assert.equal((await before.json()).error.code, 'identity_provider_unavailable');

    // Register a second provider (e.g. a future enterprise IdP): login now
    // flows through it — Core, routes, sessions, authorization untouched.
    app.users.registry.register({
      providerKey: 'test-idp',
      async authenticateUser({ credential }) {
        if (credential !== 'idp-ticket-42') {
          const { InvalidCredentialsError } = require('./errors');
          throw new InvalidCredentialsError();
        }
        return { subject: 'via-idp', type: 'user', displayName: 'Via IdP', organizationKey: FIRM, roles: ['receptionist'] };
      },
    });
    const res = await post(base, '/api/v1/auth/login', { credential: 'idp-ticket-42' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).subject, 'via-idp');

    // The dev provider's credentials no longer authenticate: no fallback,
    // no union — only the configured provider.
    assert.equal((await post(base, '/api/v1/auth/login', { credential: JANE_KEY })).status, 403);
  });
});

// ── Nothing else changed ────────────────────────────────────────────────────

test('HTTP: service (bridge) authentication is untouched by user sessions', async () => {
  await withServer({ consoleAuth: 'required' }, async (base) => {
    // The scheduling assistant still authenticates with its bearer secret —
    // no cookie involved — and its permissions are unchanged.
    const res = await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 404, 'authenticated + authorized; no session prepared');
    assert.equal((await res.json()).error.code, 'no_prepared_session');
  });
});
