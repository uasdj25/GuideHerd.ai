'use strict';

/**
 * GuideHerd Authorization tests (ADR-0010).
 *
 * Unit tests drive the policy decision point directly; HTTP tests prove the
 * boundary end to end — organization scoping, capability pinning, the
 * prepared-session cap, audit hygiene, and that every denial is the same
 * generic 403 revealing nothing about other tenants' resources.
 *
 * All data is synthetic; all time comes from the fixed clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { validateIdentityClaim } = require('./contract');
const { SCHEDULING_ASSISTANT_ROLE } = require('./static-token-provider');
const {
  createAuthorization,
  PERMISSIONS,
  DEFAULT_POLICY,
  CAPABILITY_GRANTS,
} = require('./authorization');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

/** An org-scoped scheduling-assistant identity for `org`. */
function assistantIdentity(org) {
  return validateIdentityClaim({
    subject: `assistant-${org}`,
    type: 'service',
    organizationKey: org,
    roles: [SCHEDULING_ASSISTANT_ROLE],
  }, 'static-token');
}

/** An authorization service that records audit lines instead of logging. */
function makeAuthz(options = {}) {
  const auditLines = [];
  const authz = createAuthorization({ log: (l) => auditLines.push(JSON.parse(l)), ...options });
  return { authz, auditLines };
}

// ── Policy decisions ────────────────────────────────────────────────────────

test('authorization: an allowed permission succeeds; a missing permission is a generic 403', () => {
  const { authz } = makeAuthz();
  const identity = assistantIdentity(FIRM);

  assert.equal(authz.authorize({ identity }, 'conversation:connect', { organizationKey: FIRM }), true);
  assert.equal(authz.authorize({ identity }, 'summary:read', { organizationKey: FIRM }), true);

  for (const denied of ['handoff:create', 'handoff:cancel', 'configuration:read']) {
    assert.throws(
      () => authz.authorize({ identity }, denied, { organizationKey: FIRM }),
      (e) => e.status === 403 && e.code === 'forbidden',
      `service identity must not hold ${denied}`,
    );
  }
});

test('authorization: unknown permissions, roles, and principals fail closed', () => {
  const { authz } = makeAuthz();
  const identity = assistantIdentity(FIRM);

  assert.throws(() => authz.authorize({ identity }, 'admin:everything', { organizationKey: FIRM }), (e) => e.status === 403);
  assert.throws(() => authz.authorize({}, 'summary:read', { organizationKey: FIRM }), (e) => e.status === 403);
  assert.throws(() => authz.authorize(null, 'summary:read', { organizationKey: FIRM }), (e) => e.status === 403);

  const unknownRole = validateIdentityClaim({
    subject: 'stranger', type: 'service', organizationKey: FIRM, roles: ['mystery-role'],
  }, 'static-token');
  assert.throws(() => authz.authorize({ identity: unknownRole }, 'summary:read', { organizationKey: FIRM }), (e) => e.status === 403);
});

test('authorization: organization A can never act on organization B — and the denial reveals nothing', () => {
  const { authz } = makeAuthz();
  const orgA = assistantIdentity('org-a');

  assert.equal(authz.authorize({ identity: orgA }, 'conversation:connect', { organizationKey: 'org-a' }), true);

  let crossTenant;
  try {
    authz.authorize({ identity: orgA }, 'conversation:connect', { organizationKey: 'org-b' });
    assert.fail('cross-tenant access must be rejected');
  } catch (e) { crossTenant = e; }

  let noPermission;
  try {
    authz.authorize({ identity: orgA }, 'handoff:create', { organizationKey: 'org-a' });
    assert.fail('missing permission must be rejected');
  } catch (e) { noPermission = e; }

  // Structurally indistinguishable denials: same status, code, and message.
  assert.deepEqual(
    { s: crossTenant.status, c: crossTenant.code, m: crossTenant.message },
    { s: noPermission.status, c: noPermission.code, m: noPermission.message },
    'a cross-tenant denial must not be distinguishable from a permission denial',
  );
});

test('authorization: platform scope is explicit — a missing organizationKey never means global access', () => {
  const { authz } = makeAuthz();

  // An org-scoped role WITHOUT an organizationKey: denied everywhere.
  const unscoped = validateIdentityClaim({
    subject: 'unscoped-assistant', type: 'service', roles: [SCHEDULING_ASSISTANT_ROLE],
  }, 'static-token');
  assert.throws(() => authz.authorize({ identity: unscoped }, 'conversation:connect', { organizationKey: FIRM }), (e) => e.status === 403);

  // Platform reach exists only where a role mapping declares it.
  const { authz: platformAuthz } = makeAuthz({
    policy: {
      roles: {
        'guideherd-operator': { scope: 'platform', permissions: ['summary:read'] },
        [SCHEDULING_ASSISTANT_ROLE]: DEFAULT_POLICY.roles[SCHEDULING_ASSISTANT_ROLE],
      },
      anonymous: DEFAULT_POLICY.anonymous,
    },
  });
  const operator = validateIdentityClaim({
    subject: 'ops', type: 'service', roles: ['guideherd-operator'],
  }, 'static-token');
  assert.equal(platformAuthz.authorize({ identity: operator }, 'summary:read', { organizationKey: 'any-org' }), true);
  assert.throws(() => platformAuthz.authorize({ identity: operator }, 'conversation:connect', { organizationKey: 'any-org' }), (e) => e.status === 403, 'platform scope does not widen permissions');

  // No production role is platform-scoped.
  for (const role of Object.values(DEFAULT_POLICY.roles)) {
    assert.equal(role.scope, 'organization', 'production policy contains no platform-scoped role');
  }
});

test('authorization: anonymous holds exactly the declared public grants', () => {
  const { authz } = makeAuthz();
  assert.deepEqual([...DEFAULT_POLICY.anonymous], ['handoff:create', 'configuration:read']);

  assert.equal(authz.authorize({ anonymous: true }, 'handoff:create', { organizationKey: FIRM }), true);
  assert.equal(authz.authorize({ anonymous: true }, 'configuration:read', { organizationKey: FIRM }), true);
  for (const permission of PERMISSIONS.filter((p) => !DEFAULT_POLICY.anonymous.includes(p))) {
    assert.throws(() => authz.authorize({ anonymous: true }, permission, { organizationKey: FIRM }), (e) => e.status === 403, `anonymous must not hold ${permission}`);
  }
});

test('authorization: capabilities are pinned to their operation set and their exact session', () => {
  const { authz } = makeAuthz();
  const onSession = { resource: { type: 'handoff-session', id: 'session-1' } };

  assert.deepEqual({ ...CAPABILITY_GRANTS }, {
    'handoff-token': ['handoff:redeem'],
    'console-token': ['handoff:read', 'handoff:cancel'],
  });

  const consoleCap = { capability: { type: 'console-token', sessionId: 'session-1' } };
  assert.equal(authz.authorize(consoleCap, 'handoff:read', onSession), true);
  assert.equal(authz.authorize(consoleCap, 'handoff:cancel', onSession), true);
  assert.throws(() => authz.authorize(consoleCap, 'handoff:redeem', onSession), (e) => e.status === 403, 'a console token can never redeem caller context');
  assert.throws(
    () => authz.authorize(consoleCap, 'handoff:read', { resource: { type: 'handoff-session', id: 'session-2' } }),
    (e) => e.status === 403,
    'a capability never reaches another session',
  );

  const handoffCap = { capability: { type: 'handoff-token', sessionId: 'session-1' } };
  assert.equal(authz.authorize(handoffCap, 'handoff:redeem', onSession), true);
  assert.throws(() => authz.authorize(handoffCap, 'handoff:cancel', onSession), (e) => e.status === 403);

  // Malformed capability facts fail closed.
  assert.throws(() => authz.authorize({ capability: { type: 'root-token', sessionId: 'session-1' } }, 'handoff:read', onSession), (e) => e.status === 403);
  assert.throws(() => authz.authorize({ capability: { type: 'console-token', sessionId: '' } }, 'handoff:read', onSession), (e) => e.status === 403);
  assert.throws(() => authz.authorize(consoleCap, 'handoff:read', {}), (e) => e.status === 403, 'no resource context = no access');
});

// ── Audit hygiene ───────────────────────────────────────────────────────────

test('audit: denials are logged with safe fields only; polling successes are silent; opt-in successes log', () => {
  const { authz, auditLines } = makeAuthz();
  const identity = assistantIdentity(FIRM);

  // Silent success (no opt-in — the console-polling default).
  authz.authorize({ identity }, 'conversation:connect', { organizationKey: FIRM });
  assert.equal(auditLines.length, 0, 'successes are not audited unless opted in');

  // Opt-in success.
  authz.authorize({ identity }, 'conversation:connect', { organizationKey: FIRM, auditSuccess: true });
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].event, 'authorization.allowed');

  // Denial.
  assert.throws(() => authz.authorize({ identity }, 'handoff:create', {
    organizationKey: FIRM,
    resource: { type: 'handoff-session', id: 'session-9' },
  }));
  const denial = auditLines[1];
  assert.equal(denial.event, 'authorization.denied');
  assert.equal(denial.subject, `assistant-${FIRM}`);
  assert.equal(denial.identityType, 'service');
  assert.equal(denial.organizationKey, FIRM);
  assert.equal(denial.permission, 'handoff:create');
  assert.equal(denial.resourceType, 'handoff-session');
  assert.equal(denial.sessionId, 'session-9');

  // Nothing sensitive ever appears in audit events.
  const flat = JSON.stringify(auditLines);
  assert.equal(/Bearer|gh_handoff_|gh_console_|token|secret|@|phone|caller/i.test(flat), false, 'audit events carry identifiers and decision facts only');
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

function createBody(firmId = FIRM) {
  return {
    firmId,
    caller: { fullName: 'Test Caller', email: 'caller@example.com', phone: '+12565550100' },
    scheduling: { consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

test('HTTP: a service identity scoped to another organization is structurally rejected from the demo firm', async () => {
  const staticIdentitiesJson = JSON.stringify([
    { token: 'tok-other-org', subject: 'assistant-other', type: 'service', roles: [SCHEDULING_ASSISTANT_ROLE], organizationKey: 'other-firm' },
  ]);
  await withServer({ staticIdentitiesJson }, async (base) => {
    await post(base, '/api/v1/handoffs', createBody()); // a session EXISTS for the demo firm
    const res = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer tok-other-org' });
    assert.equal(res.status, 403, 'right role, wrong organization: denied');
    const body = await res.json();
    assert.equal(body.error.code, 'forbidden');
    assert.equal(JSON.stringify(body).includes('session'), false, 'the denial reveals nothing about existing resources');
  });
});

test('HTTP: the production bridge identity performs only its scheduling operations', async () => {
  await withServer({}, async (base) => {
    const auth = { authorization: `Bearer ${SECRET}` };
    await post(base, '/api/v1/handoffs', createBody());

    // Allowed: connect (its permission set).
    const connect = await post(base, '/api/v1/demo/connect', {}, auth);
    assert.equal(connect.status, 200);

    // The same credential holds no handoff:read/cancel: the console
    // capability routes reject it (unknown console token -> 403/404 path
    // through the store) — but the AUTHORIZATION boundary is what blocks
    // any route that would require an unrelated permission. Proven at the
    // unit level; here we prove the workflow end-to-end still works.
    const outcome = await post(base, '/api/v1/demo/outcome', {
      sessionId: (await connect.json()).sessionId,
      status: 'booked',
      appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' },
      reason: 'Booked.',
    }, auth);
    assert.equal(outcome.status, 200);

    const summary = await fetch(`${base}/api/v1/demo/summary/latest`, { headers: auth });
    assert.equal(summary.status, 200);
  });
});

test('HTTP: the prepared-session cap contains anonymous create abuse per organization', async () => {
  await withServer({ maxPreparedSessions: 2 }, async (base) => {
    assert.equal((await post(base, '/api/v1/handoffs', createBody())).status, 201);
    assert.equal((await post(base, '/api/v1/handoffs', createBody())).status, 201);

    const capped = await post(base, '/api/v1/handoffs', createBody());
    assert.equal(capped.status, 429);
    assert.equal((await capped.json()).error.code, 'too_many_prepared_sessions');

    // The cap is per organization: another firm is unaffected.
    assert.equal((await post(base, '/api/v1/handoffs', createBody('other-firm'))).status, 201);
  });
});

test('HTTP: the cap releases as sessions leave the prepared state', async () => {
  await withServer({ maxPreparedSessions: 1 }, async (base) => {
    const first = await (await post(base, '/api/v1/handoffs', createBody())).json();
    assert.equal((await post(base, '/api/v1/handoffs', createBody())).status, 429);

    await fetch(`${base}/api/v1/handoffs/${first.sessionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${first.consoleToken}` },
    });
    assert.equal((await post(base, '/api/v1/handoffs', createBody())).status, 201, 'cancellation frees capacity');
  });
});

test('HTTP: console capability flow is unchanged — status and cancel with the session token only', async () => {
  await withServer({}, async (base) => {
    const created = await (await post(base, '/api/v1/handoffs', createBody())).json();
    const auth = { authorization: `Bearer ${created.consoleToken}` };

    const statusRes = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, { headers: auth });
    assert.equal(statusRes.status, 200);
    assert.equal((await statusRes.json()).status, 'awaiting-transfer');

    // The console token of session A cannot read session B.
    const other = await (await post(base, '/api/v1/handoffs', createBody())).json();
    const cross = await fetch(`${base}/api/v1/handoffs/${other.sessionId}`, { headers: auth });
    assert.equal(cross.status, 403, 'capability pinned to its own session');

    const cancel = await fetch(`${base}/api/v1/handoffs/${created.sessionId}`, { method: 'DELETE', headers: auth });
    assert.equal(cancel.status, 200);
  });
});

test('HTTP: authorization denials over the wire never leak identifiers, tokens, or PII', async () => {
  const logged = [];
  const original = console.log;
  console.log = (l) => logged.push(String(l));
  try {
    const staticIdentitiesJson = JSON.stringify([
      { token: 'tok-other-org', subject: 'assistant-other', type: 'service', roles: [SCHEDULING_ASSISTANT_ROLE], organizationKey: 'other-firm' },
    ]);
    await withServer({ staticIdentitiesJson }, async (base) => {
      await post(base, '/api/v1/handoffs', createBody());
      const res = await post(base, '/api/v1/demo/connect', {}, { authorization: 'Bearer tok-other-org' });
      assert.equal(res.status, 403);
    });
    const flat = logged.join('\n');
    assert.ok(flat.includes('authorization.denied'), 'the denial is audited');
    assert.equal(/tok-other-org|demo-secret|gh_handoff_|gh_console_|Test Caller|caller@example\.com|2565550100/.test(flat), false,
      'no tokens, secrets, or caller PII in logs');
  } finally {
    console.log = original;
  }
});
