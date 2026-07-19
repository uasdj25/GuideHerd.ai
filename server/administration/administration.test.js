'use strict';

/**
 * Administration Framework tests (ADR-0015).
 *
 * Covers the Administration Contract: validated change application,
 * optimistic concurrency, audit history with before/after snapshots,
 * unknown-area loud failure, authorization over HTTP, organization
 * isolation, LIVE configuration consumption (a change is visible to its
 * consumer on the very next request, no restart), and unchanged existing
 * workflows. Deterministic throughout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { resolveSchedulingPolicy } = require('../scheduling/policy');
const { resolveBranding } = require('../notifications/branding');
const { createAdministrationService } = require('./service');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const SECRET = 'demo-secret-for-tests-only';
const FIRM = 'martinson-beason';

const DEV_USERS = JSON.stringify([
  { key: 'dev-key-admin-0123456789abcde', subject: 'admin-ada', displayName: 'Ada Admin', organizationKey: FIRM, roles: ['administrator'] },
  { key: 'dev-key-jane-0123456789abcdef', subject: 'jane-doe', displayName: 'Jane Doe', organizationKey: FIRM, roles: ['receptionist'] },
  { key: 'dev-key-otheradmin-012345678a', subject: 'admin-oz', displayName: 'Oz Admin', organizationKey: 'other-firm', roles: ['administrator'] },
]);

function fixture() {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  const configService = createConfigService({ db, clock: fixedClock(T0) });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: 'America/New_York' });
  configService.serviceAreas.create(FIRM, { key: 'personal-injury', name: 'Personal Injury', displayOrder: 1 });
  configService.providers.create(FIRM, { key: 'clay-martinson', name: 'Clay Martinson' });
  configService.providers.create(FIRM, { key: 'morris-lilienthal', name: 'Morris Lilienthal' });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', displayOrder: 1 });
  configService.routingGroups.create(FIRM, { key: 'pi-team', name: 'PI Team', serviceArea: 'personal-injury', providers: ['clay-martinson', 'morris-lilienthal'] });
  return { db, configService };
}

function makeAdmin(overrides = {}) {
  const { db, configService } = fixture();
  const admin = createAdministrationService({
    configService,
    configDb: db,
    clock: fixedClock(T0),
    identityProviderKeys: () => ['static-token', 'entra'],
    ...overrides,
  });
  return { db, configService, admin };
}

const CTX = { actor: 'admin-ada', organizationKey: FIRM };

// ── The contract: validation, versioning, audit ─────────────────────────────

test('administration: changes apply, version, and audit with before/after snapshots', () => {
  const { admin, configService } = makeAdmin();

  const first = admin.apply('organization', CTX, { displayName: 'M&B' });
  assert.equal(first.version, 1);
  assert.equal(configService.organizations.get(FIRM).displayName, 'M&B');

  const second = admin.apply('organization', CTX, { displayName: 'Martinson & Beason' }, 1);
  assert.equal(second.version, 2);

  const audit = admin.audit(FIRM, { entity: 'organization' });
  assert.equal(audit.length, 2);
  assert.equal(audit[0].version, 2);
  assert.equal(audit[0].actor, 'admin-ada');
  assert.equal(audit[0].before.displayName, 'M&B', 'before snapshot captured — rollback foundation');
  assert.equal(audit[0].after.displayName, 'Martinson & Beason');
  assert.equal(audit[0].at, '2026-07-12T15:15:00.000Z');
});

test('administration: consultation types and routing groups are fully administrable areas (#67)', () => {
  const { admin, configService } = makeAdmin();
  const ctx = { actor: 'admin-ada', organizationKey: FIRM };

  // Consultation types: create, rename, deactivate — audited, versioned.
  const created = admin.apply('consultation-types', ctx, {
    action: 'create', fields: { key: 'case-review', name: 'Case Review', displayOrder: 2 },
  });
  assert.equal(created.result.key, 'case-review');
  assert.deepEqual(configService.consultationTypes.list(FIRM, {}).map((t) => t.key).sort(),
    ['case-review', 'initial-consultation']);
  const renamed = admin.apply('consultation-types', ctx, {
    action: 'update', key: 'case-review', fields: { name: 'Case Review Session' },
  });
  assert.equal(renamed.result.name, 'Case Review Session');
  const deactivated = admin.apply('consultation-types', ctx, {
    action: 'update', key: 'case-review', fields: { active: false },
  }, renamed.version);
  assert.equal(deactivated.result.active, false);

  // Routing groups: create with practice-area assignment; reassign.
  configService.serviceAreas.create(FIRM, { key: 'family-law', name: 'Family Law', displayOrder: 2 });
  const group = admin.apply('routing-groups', ctx, {
    action: 'create', fields: { key: 'family-team', name: 'Family Team', serviceArea: 'family-law' },
  });
  assert.equal(group.result.serviceArea, 'family-law');
  const moved = admin.apply('routing-groups', ctx, {
    action: 'update', key: 'family-team', fields: { serviceArea: 'personal-injury' },
  });
  assert.equal(moved.result.serviceArea, 'personal-injury');

  // Both areas fail loudly on nonsense; validation writes nothing.
  assert.throws(() => admin.apply('consultation-types', ctx, { action: 'destroy' }),
    (e) => e.name === 'ValidationError' || e.code === 'validation_error');
  assert.throws(() => admin.apply('routing-groups', ctx,
    { action: 'create', fields: { key: 'x', name: 'X', serviceArea: 'no-such-area' } }));

  // describe() now surfaces consultation types for the portal.
  const view = admin.describe(FIRM);
  assert.ok(view.consultationTypes.some((t) => t.key === 'case-review'));

  // The audit trail carries the new entities.
  const audit = admin.audit(FIRM, { limit: 20 });
  assert.ok(audit.some((a) => a.entity === 'consultation-types' && a.action === 'create'));
  assert.ok(audit.some((a) => a.entity === 'routing-group:family-team'));
});

test('administration: optimistic concurrency — a stale expectedVersion is an explicit 409 and writes nothing', () => {
  const { admin, configService } = makeAdmin();
  admin.apply('organization', CTX, { displayName: 'Version One' }); // v1

  assert.throws(
    () => admin.apply('organization', CTX, { displayName: 'From a stale read' }, 0),
    (e) => e.status === 409 && e.code === 'configuration_version_conflict',
  );
  assert.equal(configService.organizations.get(FIRM).displayName, 'Version One', 'the losing write changed nothing');
  assert.equal(admin.audit(FIRM, { entity: 'organization' }).length, 1, 'no audit row for the refused write');
});

test('administration: consumer-owned validation — an invalid scheduling policy is refused outright, nothing written', () => {
  const { admin, configService } = makeAdmin();

  assert.throws(
    () => admin.apply('scheduling-policy', CTX, { preferredTimeOfDay: 'brunch', preferredAttorneys: ['clay-martinson'] }),
    (e) => e.status === 400 && e.code === 'validation_error',
    'administration is stricter than runtime fail-safety: any invalid field refuses the whole document',
  );
  assert.equal(resolveSchedulingPolicy(configService, FIRM).policy, null, 'partial invalid configuration is never written');

  const ok = admin.apply('scheduling-policy', CTX, { preferredTimeOfDay: 'morning' });
  assert.equal(ok.version, 1);
  assert.deepEqual(resolveSchedulingPolicy(configService, FIRM).policy, { preferredTimeOfDay: 'morning' });
});

test('administration: unknown areas and unknown entities fail loudly; nothing partial is written', () => {
  const { admin } = makeAdmin();
  assert.throws(() => admin.apply('billing', CTX, {}), (e) => e.code === 'unknown_administration_area');
  assert.throws(() => admin.apply('attorneys', CTX, { action: 'update', key: 'no-such-attorney', fields: { name: 'X' } }),
    (e) => e.code === 'unknown_provider');
  assert.throws(() => admin.apply('organization', CTX, { name: '' }), (e) => e.status === 400);
  assert.throws(() => admin.apply('notifications', CTX, { enabled: 'yes' }), (e) => e.status === 400);
  assert.equal(admin.audit(FIRM).length, 0, 'refused changes leave no audit rows');
});

test('administration: identity provider selection validates against registered providers', () => {
  const { admin, configService } = makeAdmin();
  assert.throws(
    () => admin.apply('identity-provider', CTX, { provider: 'okta' }),
    (e) => e.status === 400,
    'an unregistered provider would break every login — refused',
  );
  admin.apply('identity-provider', CTX, { provider: 'entra' });
  assert.deepEqual(configService.settings.get(FIRM, 'identity', 'provider').value, { provider: 'entra' });
});

test('administration: attorney ordering, branding, business hours, and describe round-trip', () => {
  const { admin, configService } = makeAdmin();

  admin.apply('attorney-order', CTX, { groupKey: 'pi-team', attorneys: ['morris-lilienthal', 'clay-martinson'] });
  assert.deepEqual(configService.routingGroups.get(FIRM, 'pi-team').providers, ['morris-lilienthal', 'clay-martinson']);

  admin.apply('notification-branding', CTX, { senderName: 'M&B Law', accentColor: '#aa0000' });
  assert.equal(resolveBranding(configService, FIRM).senderName, 'M&B Law');
  assert.throws(() => admin.apply('notification-branding', CTX, { logoUrl: 'http://insecure.example/x.png' }), (e) => e.status === 400);

  admin.apply('office', CTX, { action: 'create', fields: { key: 'main', name: 'Main Office', phone: '(256) 555-0100' } });
  admin.apply('business-hours', CTX, { locationKey: 'main', officeHours: [{ dayOfWeek: 1, opens: '08:30', closes: '17:00' }] });
  const described = admin.describe(FIRM);
  assert.equal(described.locations[0].officeHours[0].opens, '08:30');
  assert.equal(described.organization.version, 0, 'untouched entities report version 0');
  assert.deepEqual(described.settings.notifications.value, null);
  assert.ok(described.registeredIdentityProviders.includes('entra'));
  // Configuration authority (ADR-0022): the default descriptor says this
  // service's writes are authoritative; server.js overrides with reality.
  assert.deepEqual(described.configurationAuthority, { mode: 'live', seedOnBoot: false, lastBootImport: 'none' });
  assert.throws(() => admin.apply('business-hours', CTX, { locationKey: 'main', officeHours: [{ dayOfWeek: 9, opens: '08:00', closes: '17:00' }] }), (e) => e.status === 400);
});

// ── HTTP: authorization, isolation, live consumption ────────────────────────

async function withServer(opts, fn) {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  const configService = createConfigService({ db, clock: fixedClock(T0) });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: 'America/New_York' });
  configService.serviceAreas.create(FIRM, { key: 'personal-injury', name: 'Personal Injury', displayOrder: 1 });
  configService.providers.create(FIRM, { key: 'clay-martinson', name: 'Clay Martinson' });
  configService.providers.create(FIRM, { key: 'morris-lilienthal', name: 'Morris Lilienthal' });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', displayOrder: 1 });
  configService.routingGroups.create(FIRM, { key: 'pi-team', name: 'PI Team', serviceArea: 'personal-injury', providers: ['clay-martinson', 'morris-lilienthal'] });

  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    configService,
    configDb: db,
    devUsersJson: DEV_USERS,
    ...opts,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, app, configService);
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

async function loginCookie(base, credential) {
  const res = await post(base, '/api/v1/auth/login', { credential });
  const match = (res.headers.get('set-cookie') || '').match(/gh_session=([^;]*)/);
  return { cookie: `gh_session=${match ? match[1] : ''}` };
}

test('HTTP: administration requires a session and administrative permissions', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/admin/configuration`)).status, 401, 'anonymous rejected');

    const receptionist = await loginCookie(base, 'dev-key-jane-0123456789abcdef');
    assert.equal((await fetch(`${base}/api/v1/admin/configuration`, { headers: receptionist })).status, 403,
      'receptionists are not automatically administrators');
    assert.equal((await post(base, '/api/v1/admin/organization', { payload: { displayName: 'Nope' } }, receptionist)).status, 403);

    const admin = await loginCookie(base, 'dev-key-admin-0123456789abcde');
    const described = await fetch(`${base}/api/v1/admin/configuration`, { headers: admin });
    assert.equal(described.status, 200);
    const payload = await described.json();
    assert.equal(payload.organization.key, FIRM);
    // Configuration authority (ADR-0022) reaches the portal payload.
    assert.equal(payload.configurationAuthority.mode, 'live');
  });
});

test('HTTP: a seed-managed deployment tells its administrators so (ADR-0022)', async () => {
  const authority = { mode: 'seed-managed', seedOnBoot: true, lastBootImport: 'imported' };
  await withServer({ configurationAuthority: authority }, async (base) => {
    const admin = await loginCookie(base, 'dev-key-admin-0123456789abcde');
    const payload = await (await fetch(`${base}/api/v1/admin/configuration`, { headers: admin })).json();
    assert.deepEqual(payload.configurationAuthority, authority);
  });
});

test('HTTP: administration is organization-scoped — cross-organization administration is impossible', async () => {
  await withServer({}, async (base) => {
    // The other firm's administrator sees and changes ONLY their firm:
    // the organization comes from the server-held session, and no admin
    // route accepts an organization identifier at all.
    const outsider = await loginCookie(base, 'dev-key-otheradmin-012345678a');
    const described = await (await fetch(`${base}/api/v1/admin/configuration`, { headers: outsider })).json();
    assert.equal(described.organization.key, 'other-firm');
    assert.equal(described.attorneys.length, 0, "no visibility into martinson-beason's attorneys");

    const change = await post(base, '/api/v1/admin/organization', { payload: { displayName: 'Renamed' } }, outsider);
    assert.equal(change.status, 200);
    const admin = await loginCookie(base, 'dev-key-admin-0123456789abcde');
    const mine = await (await fetch(`${base}/api/v1/admin/configuration`, { headers: admin })).json();
    assert.equal(mine.organization.name, 'Martinson & Beason, P.C.', "the other admin's change touched only their organization");
    assert.equal(mine.organization.displayName ?? null, null, 'no cross-organization write occurred');
    assert.equal((await (await fetch(`${base}/api/v1/admin/audit`, { headers: admin })).json()).audit.length, 0, 'audit is organization-scoped too');
  });
});

test('HTTP: LIVE configuration — an administered change affects the platform on the next request, no restart', async () => {
  await withServer({}, async (base, app, configService) => {
    const admin = await loginCookie(base, 'dev-key-admin-0123456789abcde');

    // Attorney ordering: reorder, then the public scheduling-options
    // endpoint reflects it immediately.
    const before = await (await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`)).json();
    assert.deepEqual(before.attorneysByPracticeArea['personal-injury'].map((a) => a.id), ['clay-martinson', 'morris-lilienthal']);

    const reorder = await post(base, '/api/v1/admin/attorney-order', {
      payload: { groupKey: 'pi-team', attorneys: ['morris-lilienthal', 'clay-martinson'] },
      expectedVersion: 0,
    }, admin);
    assert.equal(reorder.status, 200);

    const after = await (await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`)).json();
    assert.deepEqual(after.attorneysByPracticeArea['personal-injury'].map((a) => a.id), ['morris-lilienthal', 'clay-martinson'],
      'live: the Console would render the new order on its next load');

    // Scheduling policy: administered, then the engine resolves it live.
    await post(base, '/api/v1/admin/scheduling-policy', { payload: { preferredAttorneys: ['morris-lilienthal'] } }, admin);
    const resolved = resolveSchedulingPolicy(configService, FIRM);
    assert.deepEqual(resolved.policy, { preferredAttorneys: ['morris-lilienthal'] });

    // Optimistic concurrency over HTTP: a stale version is a 409.
    const stale = await post(base, '/api/v1/admin/attorney-order', {
      payload: { groupKey: 'pi-team', attorneys: ['clay-martinson', 'morris-lilienthal'] },
      expectedVersion: 0,
    }, admin);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'configuration_version_conflict');
  });
});

test('HTTP: notification enablement administered live — the booked-confirmation trigger obeys the new setting', async () => {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  const configService = createConfigService({ db, clock: fixedClock(T0) });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', displayOrder: 1 });

  const app = createApp({
    demoBridgeSecret: SECRET,
    clock: fixedClock(T0),
    mailer: { enabled: true, async sendSummary() { return { status: 'sent' }; } },
    configService,
    configDb: db,
    devUsersJson: DEV_USERS,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sent = [];
  app.notifications.registry.register({
    providerKey: 'capture',
    async deliver(message, context) { sent.push(context.notificationKey); return { status: 'sent' }; },
  });
  configService.settings.set(FIRM, 'notifications', 'provider', { provider: 'capture' });

  try {
    const admin = await loginCookie(base, 'dev-key-admin-0123456789abcde');
    // Enable confirmations THROUGH administration (audited, versioned).
    const enable = await post(base, '/api/v1/admin/notifications', { payload: { enabled: true }, expectedVersion: 0 }, admin);
    assert.equal(enable.status, 200);

    // A booked workflow now sends exactly one confirmation — no restart.
    const created = await (await post(base, '/api/v1/handoffs', {
      firmId: FIRM,
      caller: { fullName: 'Live Caller', email: 'live@example.com', phone: '+12565550100' },
      scheduling: { consultationTypeId: 'initial-consultation' },
      handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
    })).json();
    await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` });
    await post(base, '/api/v1/demo/outcome', {
      sessionId: created.sessionId, status: 'booked',
      appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago' }, reason: 'Booked.',
    }, { authorization: `Bearer ${SECRET}` });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [`appointment-confirmation:${created.sessionId}`], 'administered enablement took effect live');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP: existing workflows are unchanged by the Administration Framework', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`)).status, 200);
    const created = await (await post(base, '/api/v1/handoffs', {
      firmId: FIRM,
      caller: { fullName: 'Unchanged Caller', email: 'u@example.com' },
      scheduling: { consultationTypeId: 'initial-consultation' },
      handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
    })).json();
    assert.ok(created.sessionId);
    assert.equal((await post(base, '/api/v1/demo/connect', {}, { authorization: `Bearer ${SECRET}` })).status, 200);
  });
});
