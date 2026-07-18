'use strict';

/**
 * GuideHerd Identity Contract tests (ADR-0009).
 *
 * Unit tests cover the contract validation, the provider registry, the
 * StaticTokenProvider, and provider-selection configuration. HTTP tests
 * prove the architecture end to end: authentication flows ONLY through the
 * identity middleware and the configured provider — including through a
 * synthetic provider selected via the Configuration Store, with zero
 * provider-specific logic in any route.
 *
 * All data is synthetic; no external identity system is ever called.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { validateIdentityClaim, createIdentityProviderRegistry } = require('./contract');
const { createStaticTokenProvider, SCHEDULING_ASSISTANT_ROLE } = require('./static-token-provider');
const { createIdentityService, requireRole } = require('./middleware');
const {
  resolveIdentityProviderKey,
  DEFAULT_IDENTITY_PROVIDER,
  SETTINGS_NAMESPACE,
  SETTINGS_KEY,
} = require('./provider-config');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

// ── Contract validation ─────────────────────────────────────────────────────

const VALID_CLAIM = Object.freeze({
  subject: 'scheduling-assistant',
  type: 'service',
  displayName: 'GuideHerd Scheduling Assistant',
  organizationKey: null,
  roles: ['scheduling-assistant'],
});

/** Silence the contract-violation operator log inside `fn`. */
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('identity contract: a valid claim canonicalizes, freezes, and stamps provenance', () => {
  const identity = validateIdentityClaim({ ...VALID_CLAIM, subject: '  scheduling-assistant  ' }, 'static-token');
  assert.equal(identity.subject, 'scheduling-assistant');
  assert.equal(identity.type, 'service');
  assert.equal(identity.provider, 'static-token', 'provenance is stamped by the contract, not claimed');
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(identity.roles));
  assert.throws(() => { identity.roles.push('admin'); }, TypeError, 'roles cannot be mutated');
});

test('identity contract: providers cannot smuggle unknown keys, token material, or provenance', async () => {
  await quietly(async () => {
    for (const bad of [
      null, [], 'x',
      { ...VALID_CLAIM, token: 'gh_secret' },
      { ...VALID_CLAIM, provider: 'spoofed' },
      { ...VALID_CLAIM, rawPayload: {} },
      { ...VALID_CLAIM, subject: '' },
      { ...VALID_CLAIM, subject: undefined },
      { ...VALID_CLAIM, type: 'superuser' },
      { ...VALID_CLAIM, roles: 'admin' },
      { ...VALID_CLAIM, roles: ['ok', ''] },
    ]) {
      assert.throws(
        () => validateIdentityClaim(bad, 'static-token'),
        (e) => e.status === 500 && e.code === 'identity_contract_violation',
      );
    }
  });
});

// ── Provider registry ───────────────────────────────────────────────────────

test('identity registry: resolves registered providers; unknown providers fail loudly (503)', () => {
  const registry = createIdentityProviderRegistry();
  const provider = registry.register(createStaticTokenProvider({ demoBridgeSecret: SECRET }));
  assert.equal(registry.resolve('static-token'), provider);
  assert.deepEqual(registry.keys(), ['static-token']);
  assert.throws(() => registry.resolve('authentik'), (e) => e.status === 503 && e.code === 'identity_provider_unavailable');
  assert.throws(() => registry.register({}), TypeError);
  assert.throws(() => registry.register({ providerKey: 'x' }), TypeError, 'authenticate() is required');
});

// ── StaticTokenProvider ─────────────────────────────────────────────────────

test('static provider: authenticates configured tokens into identity claims', async () => {
  const provider = createStaticTokenProvider({
    staticIdentitiesJson: JSON.stringify([
      { token: 'tok-reporting', subject: 'reporting-job', type: 'service', roles: ['reporting'], organizationKey: FIRM },
    ]),
    demoBridgeSecret: SECRET,
  });
  assert.equal(provider.size(), 2);

  const reporting = await provider.authenticate({ bearerToken: 'tok-reporting' });
  assert.equal(reporting.subject, 'reporting-job');
  assert.equal(reporting.organizationKey, FIRM);

  const assistant = await provider.authenticate({ bearerToken: SECRET });
  assert.equal(assistant.subject, 'scheduling-assistant');
  assert.deepEqual(assistant.roles, [SCHEDULING_ASSISTANT_ROLE]);

  await assert.rejects(() => provider.authenticate({ bearerToken: 'wrong' }), (e) => e.status === 403);
});

test('static provider: returned claims never carry token material and are copies', async () => {
  const provider = createStaticTokenProvider({ demoBridgeSecret: SECRET });
  const claim = await provider.authenticate({ bearerToken: SECRET });
  assert.equal(JSON.stringify(claim).includes(SECRET), false);
  claim.roles.push('tampered');
  const fresh = await provider.authenticate({ bearerToken: SECRET });
  assert.deepEqual(fresh.roles, [SCHEDULING_ASSISTANT_ROLE], 'mutating a claim cannot alter the provider');
});

test('static provider: no identities configured is a loud 503, not an open door', async () => {
  const provider = createStaticTokenProvider({});
  await assert.rejects(() => provider.authenticate({ bearerToken: 'anything' }), (e) => e.status === 503 && e.code === 'identity_not_configured');
});

test('static provider: malformed configuration refuses to construct', () => {
  assert.throws(() => createStaticTokenProvider({ staticIdentitiesJson: 'not json' }), /not valid JSON/);
  assert.throws(() => createStaticTokenProvider({ staticIdentitiesJson: '{}' }), /must be a JSON array/);
  assert.throws(() => createStaticTokenProvider({ staticIdentitiesJson: '[{"subject":"x","type":"service"}]' }), /has no token/);
  assert.throws(() => createStaticTokenProvider({ staticIdentitiesJson: '[{"token":"t","type":"service"}]' }), /has no subject/);
  assert.throws(() => createStaticTokenProvider({ staticIdentitiesJson: '[{"token":"t","subject":"x","type":"root"}]' }), /invalid type/);
});

// ── Provider selection configuration ────────────────────────────────────────

function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  return configService;
}

test('identity provider resolution: defaults to static-token; honors the identity/provider setting', () => {
  assert.equal(resolveIdentityProviderKey(null, FIRM), DEFAULT_IDENTITY_PROVIDER);
  assert.equal(resolveIdentityProviderKey(null, null), DEFAULT_IDENTITY_PROVIDER);

  const configService = configServiceWithFirm();
  assert.equal(resolveIdentityProviderKey(configService, FIRM), DEFAULT_IDENTITY_PROVIDER, 'unset -> default');
  assert.equal(resolveIdentityProviderKey(configService, 'unknown-org'), DEFAULT_IDENTITY_PROVIDER);

  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: 'enterprise-idp' });
  assert.equal(resolveIdentityProviderKey(configService, FIRM), 'enterprise-idp');

  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: '' });
  assert.equal(resolveIdentityProviderKey(configService, FIRM), DEFAULT_IDENTITY_PROVIDER, 'malformed -> default');
});

// ── Middleware ──────────────────────────────────────────────────────────────

function fakeRequest(authorization) {
  return { headers: authorization === undefined ? {} : { authorization } };
}

test('middleware: extracts the bearer credential exactly once, and only here', async () => {
  const registry = createIdentityProviderRegistry();
  registry.register(createStaticTokenProvider({ demoBridgeSecret: SECRET }));
  const service = createIdentityService({ registry });

  const identity = await service.authenticate(fakeRequest(`Bearer ${SECRET}`));
  assert.equal(identity.subject, 'scheduling-assistant');
  assert.equal(identity.provider, 'static-token');
  assert.equal(JSON.stringify(identity).includes(SECRET), false, 'identities carry no token material');

  await assert.rejects(() => service.authenticate(fakeRequest(undefined)), (e) => e.status === 401);
  await assert.rejects(() => service.authenticate(fakeRequest('Token x')), (e) => e.status === 401);
  await assert.rejects(() => service.authenticate(fakeRequest('Bearer wrong')), (e) => e.status === 403);
});

test('middleware: a provider claim that violates the contract never reaches Core', async () => {
  const registry = createIdentityProviderRegistry();
  registry.register({
    providerKey: 'static-token',
    async authenticate() {
      return { subject: 'x', type: 'service', roles: [], token: 'leaked-material' };
    },
  });
  const service = createIdentityService({ registry });
  await quietly(() => assert.rejects(
    () => service.authenticate(fakeRequest('Bearer anything')),
    (e) => e.code === 'identity_contract_violation',
  ));
});

test('requireRole: authorizes held roles; rejects missing ones as 403', () => {
  const identity = validateIdentityClaim(VALID_CLAIM, 'static-token');
  assert.equal(requireRole(identity, 'scheduling-assistant'), identity);
  assert.throws(() => requireRole(identity, 'administrator'), (e) => e.status === 403);
  assert.throws(() => requireRole(null, 'any'), (e) => e.status === 403);
});

// ── End to end over HTTP ────────────────────────────────────────────────────

async function withServer(opts, fn) {
  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    ...opts,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app);
  } finally {
    // Deterministic teardown: destroy any keep-alive sockets so no test's
    // connections (or the shared fetch pool's idle sockets) can outlive its
    // server and interact with a later test's port assignment.
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

test('HTTP: a static identity from GUIDEHERD_STATIC_IDENTITIES authenticates, but roles gate the surface', async () => {
  const staticIdentitiesJson = JSON.stringify([
    // Organization-scoped, per ADR-0010: an org-scoped role without an
    // organizationKey is denied — scope must be explicit.
    { token: 'tok-assistant-2', subject: 'assistant-2', type: 'service', roles: [SCHEDULING_ASSISTANT_ROLE], organizationKey: FIRM },
    { token: 'tok-reporting', subject: 'reporting-job', type: 'service', roles: ['reporting'], organizationKey: FIRM },
  ]);
  await withServer({ staticIdentitiesJson }, async (base) => {
    // Wrong role: authenticated, but not authorized for the bridge surface.
    const reporting = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer tok-reporting' });
    assert.equal(reporting.status, 403);

    // Right role (a second credential — no longer only the bridge secret).
    const assistant = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer tok-assistant-2' });
    assert.equal(assistant.status, 404, 'authenticated + authorized; no session prepared');
    assert.equal((await assistant.json()).error.code, 'no_prepared_session');
  });
});

test('HTTP: an organization configured for an unregistered identity provider fails loudly (503)', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: 'enterprise-idp' });
  await withServer({ configService }, async (base) => {
    const res = await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'identity_provider_unavailable');
  });
});

test('HTTP: authentication succeeds only through the configured provider', async () => {
  // A synthetic second provider, selected via configuration. The static
  // provider's credentials must stop working; the configured provider's
  // credentials must work — no fallback, no union.
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, SETTINGS_NAMESPACE, SETTINGS_KEY, { provider: 'test-idp' });
  await withServer({ configService }, async (base, app) => {
    app.identity.registry.register({
      providerKey: 'test-idp',
      async authenticate({ bearerToken }) {
        if (bearerToken !== 'idp-issued-token') {
          const { InvalidCredentialsError } = require('./errors');
          throw new InvalidCredentialsError();
        }
        return { subject: 'assistant-via-idp', type: 'service', roles: [SCHEDULING_ASSISTANT_ROLE], organizationKey: FIRM };
      },
    });

    const viaStatic = await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
    assert.equal(viaStatic.status, 403, 'the previously valid static credential no longer authenticates');

    const viaIdp = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer idp-issued-token' });
    assert.equal(viaIdp.status, 404, 'the configured provider authenticates; no session prepared');
  });
});

test('HTTP: malformed static identity configuration refuses to boot the app', () => {
  assert.throws(() => createApp({ staticIdentitiesJson: 'not json' }), /not valid JSON/);
});
