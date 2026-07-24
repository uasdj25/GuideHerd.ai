'use strict';

/**
 * Customer Configuration Framework tests (ADR-0016).
 *
 * Covers the domain contract (validation, normalization, defaulting,
 * migration), the producer gate vs consumer read asymmetry, unknown and
 * malformed configuration, per-organization isolation, live updates
 * through administration into consumers, and the one-registration
 * extension point. Deterministic throughout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const {
  createConfigurationFramework,
  readDomain,
  validateDomain,
  domainDescriptors,
} = require('./framework');
const { resolveSchedulingPolicy } = require('../scheduling/policy');
const { resolveBranding } = require('../notifications/branding');
const { resolveIdentityProviderKey } = require('../identity/provider-config');
const { resolveProviderKey } = require('../connect/provider-config');
const { createAdministrationService } = require('../administration/service');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const FIRM = 'martinson-beason';

function fixture() {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  const configService = createConfigService({ db, clock: fixedClock(T0) });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  configService.organizations.create({ key: 'other-firm', name: 'Other Firm', timezone: 'America/New_York' });
  return { db, configService };
}

// ── The domain model ────────────────────────────────────────────────────────

test('framework: the production domain model registers every settings domain, all LIVE', () => {
  const ids = domainDescriptors().map((d) => d.id).sort();
  assert.deepEqual(ids, [
    'appointment-reminders', 'booking-window', 'calcom-availability', 'calendar-targets', 'conversation-provider', 'data-retention',
    'default-consultation-type', 'identity-provider',
    'integration-providers', 'notification-branding', 'notification-provider', 'notifications',
    'operational-alerts', 'scheduling-policy', 'scheduling-prompt',
    'workflows',
  ]);
  assert.ok(domainDescriptors().every((d) => d.live === true), 'settings domains are live by construction');
  const owners = Object.fromEntries(domainDescriptors().map((d) => [d.id, d.owner]));
  assert.equal(owners['scheduling-policy'], 'scheduling', 'validation ownership stays with the subsystem');
  assert.equal(owners['notification-branding'], 'notifications');
  assert.equal(owners['appointment-reminders'], 'scheduler', 'the Scheduler owns its reminder configuration');
  assert.equal(owners['data-retention'], 'operational-store');
});

test('data-retention: DARK BY DEFAULT — destructive purge is off until an org explicitly opts in (#63 safety)', () => {
  const { validateDomain, readDomain } = require('./framework');
  const { openDatabase } = require('../config/db');
  const { migrate } = require('../config/migrate');
  const { createConfigService } = require('../config/service');
  const db = openDatabase(); migrate(db);
  const cs = createConfigService({ db });
  cs.organizations.create({ key: 'org-a', name: 'A', timezone: 'UTC' });

  // The CONSUMER read (what the sweep uses) with NO override → DISABLED.
  assert.deepEqual(readDomain(cs, 'data-retention', 'org-a').value,
    { enabled: false, cancelledExpiredHours: 24, terminalDays: 30 }, 'unconfigured = off');

  // Explicit opt-in enables; windows optional (suggested defaults apply).
  assert.deepEqual(validateDomain('data-retention', { enabled: true }).normalized,
    { enabled: true, cancelledExpiredHours: 24, terminalDays: 30 });
  assert.deepEqual(validateDomain('data-retention', { enabled: true, cancelledExpiredHours: 2, terminalDays: 7 }).normalized,
    { enabled: true, cancelledExpiredHours: 2, terminalDays: 7 });
  // Windows WITHOUT enable stay DISABLED — numbers alone never delete.
  assert.deepEqual(validateDomain('data-retention', { cancelledExpiredHours: 1 }).normalized,
    { enabled: false, cancelledExpiredHours: 1, terminalDays: 30 });
  // Malformed enabled / unknown field / out-of-range are rejected.
  assert.equal(validateDomain('data-retention', { enabled: 'yes' }).ok, false);
  assert.equal(validateDomain('data-retention', { enabled: true, ttl: 1 }).ok, false);
  assert.equal(validateDomain('data-retention', { enabled: true, terminalDays: 0 }).ok, false);
});

test('framework: unknown domains fail loudly in both directions', () => {
  const { configService } = fixture();
  assert.throws(() => readDomain(configService, 'billing', FIRM), (e) => e.code === 'unknown_configuration_domain');
  assert.throws(() => validateDomain('billing', {}), (e) => e.code === 'unknown_configuration_domain');
});

// ── Consumer reads: normalized, defaulted, degraded in-domain ───────────────

test('framework: consumers receive normalized values with defaults; malformed content degrades only within its domain', () => {
  const { configService } = fixture();

  // Absent settings -> pure defaults, no issues.
  assert.deepEqual(readDomain(configService, 'identity-provider', FIRM).value, { provider: 'static-token' });
  assert.deepEqual(readDomain(configService, 'notifications', FIRM).value, { enabled: false });

  // Malformed documents degrade with reported issues — value still usable.
  configService.settings.set(FIRM, 'identity', 'provider', { provider: '', junk: true });
  const degraded = readDomain(configService, 'identity-provider', FIRM);
  assert.equal(degraded.value.provider, 'static-token', 'degrades to the default');
  assert.equal(degraded.issues.length, 2);

  // …and OTHER domains are untouched by that damage (in-domain isolation).
  assert.deepEqual(readDomain(configService, 'conversation-provider', FIRM).value, { provider: 'elevenlabs' });
  assert.equal(resolveSchedulingPolicy(configService, FIRM).policy, null);
});

test('framework: per-organization isolation — one firm\'s configuration never bleeds into another', () => {
  const { configService } = fixture();
  configService.settings.set(FIRM, 'scheduling', 'policy', { preferredTimeOfDay: 'morning' });
  assert.deepEqual(resolveSchedulingPolicy(configService, FIRM).policy, { preferredTimeOfDay: 'morning' });
  assert.equal(resolveSchedulingPolicy(configService, 'other-firm').policy, null);
  assert.equal(resolveBranding(configService, 'other-firm').senderName, 'Other Firm');
});

test('framework: the refactored consumer resolvers are exact delegations (behavior parity)', () => {
  const { configService } = fixture();
  configService.settings.set(FIRM, 'connect', 'conversation-provider', { provider: 'teams', agentId: 'agent-1' });
  assert.equal(resolveProviderKey(configService, FIRM), 'teams');
  assert.equal(resolveProviderKey(null, FIRM), 'elevenlabs');
  assert.equal(resolveIdentityProviderKey(configService, 'unknown-org'), 'static-token');
  const branding = resolveBranding(configService, FIRM);
  assert.equal(branding.senderName, 'Martinson & Beason, P.C.', 'organization-name defaulting preserved');
});

// ── Producer gate: strict, canonical, unbypassable ──────────────────────────

test('framework: producers must pass strict validation; the canonical document is what persists', () => {
  const ok = validateDomain('notifications', { enabled: true });
  assert.deepEqual(ok, { ok: true, issues: [], normalized: { enabled: true } });

  const bad = validateDomain('notifications', { enabled: 'yes', extra: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.length, 2, 'every violation reported');
  assert.deepEqual(bad.normalized, { enabled: false }, 'the lenient value exists but a producer may not persist a failing document');

  const policy = validateDomain('scheduling-policy', { preferredTimeOfDay: 'brunch' });
  assert.equal(policy.ok, false, 'consumer-lenient documents are producer-strict');

  // Deployment cross-checks run only with producer context.
  const idp = validateDomain('identity-provider', { provider: 'okta' }, { identityProviderKeys: ['dev-user'] });
  assert.equal(idp.ok, false);
  assert.match(idp.issues[0], /must be one of: dev-user/);
  assert.equal(validateDomain('identity-provider', { provider: 'okta' }).ok, true, 'no context, no deployment check — consumers stay fail-safe');
});

test('framework: even a bypassing writer cannot poison consumers — the read path re-normalizes everything', () => {
  const { configService } = fixture();
  // A hypothetical producer writes garbage directly to the store,
  // skipping validateDomain entirely:
  configService.settings.set(FIRM, 'notifications', 'appointment-confirmation', { enabled: 'absolutely', evil: true });
  const read = readDomain(configService, 'notifications', FIRM);
  assert.equal(read.value.enabled, false, 'consumers still receive a safe normalized value');
  assert.ok(read.issues.length > 0, 'and the damage is visible, not silent');
});

// ── Migration / schema evolution ────────────────────────────────────────────

test('framework: domain migration upgrades historical documents on read and before write validation', () => {
  const framework = createConfigurationFramework();
  framework.register({
    id: 'demo-greeting',
    title: 'Demo greeting',
    owner: 'demo',
    namespace: 'demo',
    key: 'greeting',
    schemaVersion: 2,
    // v1 stored a bare string; v2 stores { text, tone }.
    migrate: (doc) => (typeof doc === 'string' ? { text: doc, tone: 'formal' } : doc),
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { text: 'Hello', tone: 'formal' }, issues: [] };
      const issues = [];
      const text = typeof raw.text === 'string' && raw.text.trim() !== '' ? raw.text.trim() : (issues.push('text required'), 'Hello');
      const tone = ['formal', 'friendly'].includes(raw.tone) ? raw.tone : (issues.push('tone invalid'), 'formal');
      return { value: { text, tone }, issues };
    },
  });
  const { configService } = fixture();
  configService.settings.set(FIRM, 'demo', 'greeting', 'Good morning'); // a v1 document

  const read = framework.read(configService, 'demo-greeting', FIRM);
  assert.deepEqual(read, { value: { text: 'Good morning', tone: 'formal' }, issues: [] }, 'v1 migrates transparently on read');

  const validated = framework.validate('demo-greeting', 'Howdy');
  assert.deepEqual(validated, { ok: true, issues: [], normalized: { text: 'Howdy', tone: 'formal' } },
    'a producer submitting the old shape gets the canonical current schema back');
});

// ── The extension point: one registration, end to end ───────────────────────

test('framework: a new domain is ONE registration — readable, strict-validated, and administrable with zero core changes', () => {
  const { db, configService } = fixture();

  // The extension path is exactly what domains.js does: one registration
  // carrying the domain's schema/validator. An isolated framework
  // demonstrates the full lifecycle; wiring the same registration into
  // domains.js is the single production change (administration areas are
  // registry-generated, so no other code changes anywhere).
  const framework = createConfigurationFramework();
  require('./domains').registerProductionDomains(framework);
  framework.register({
    id: 'voice-greeting',
    title: 'Voice greeting',
    owner: 'connect',
    namespace: 'connect',
    key: 'voice-greeting',
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { text: 'Thank you for calling.' }, issues: [] };
      const issues = [];
      const text = typeof raw.text === 'string' && raw.text.trim() !== '' && raw.text.length <= 300
        ? raw.text.trim() : (issues.push('text must be a nonblank string of at most 300 characters'), 'Thank you for calling.');
      for (const k of Object.keys(raw)) if (k !== 'text') issues.push(`unknown field: ${k}`);
      return { value: { text }, issues };
    },
  });
  assert.equal(framework.descriptors().length, 17, 'sixteen production domains + the new one');

  // Consumer read and producer gate work immediately.
  assert.equal(framework.read(configService, 'voice-greeting', FIRM).value.text, 'Thank you for calling.');
  assert.equal(framework.validate('voice-greeting', { text: 'Hi', junk: 1 }).ok, false);

  // Live update round-trip through the store.
  const { ok, normalized } = framework.validate('voice-greeting', { text: 'Martinson & Beason, how may we help?' });
  assert.equal(ok, true);
  configService.settings.set(FIRM, 'connect', 'voice-greeting', normalized);
  assert.equal(framework.read(configService, 'voice-greeting', FIRM).value.text, 'Martinson & Beason, how may we help?');

  // And administration areas are generated from the registry: the six
  // production domains are administrable areas today with no code in the
  // administration service naming any of them.
  const admin = createAdministrationService({
    configService, configDb: db, clock: fixedClock(T0),
    identityProviderKeys: () => ['dev-user'],
  });
  for (const id of ['scheduling-policy', 'notification-branding', 'notifications', 'identity-provider', 'conversation-provider', 'notification-provider']) {
    assert.ok(admin.areaNames().includes(id), `${id} is administrable via the registry`);
  }
});

// ── The registry is the single authoritative catalog ────────────────────────

test('conformance: no production module reads or writes settings outside the framework — registration is structurally mandatory', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  // Sanctioned settings access: the Configuration Store itself, the
  // framework's read path, and administration's snapshot/describe reads.
  const sanctioned = new Set([
    path.join('configuration', 'framework.js'),
    path.join('administration', 'service.js'),
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      const rel = path.relative(root, full);
      if (rel.startsWith('config' + path.sep)) continue; // the store's own internals
      if (sanctioned.has(rel)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/settings\s*\.\s*(get|set|list)\s*\(/.test(source)) offenders.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [],
    'a subsystem reached the settings store directly — register a configuration domain instead (ADR-0016)');
});

test('conformance: no two domains may own the same setting address', () => {
  const framework = createConfigurationFramework();
  framework.register({ id: 'a', namespace: 'x', key: 'y', normalize: () => ({ value: null, issues: [] }) });
  assert.throws(
    () => framework.register({ id: 'b', namespace: 'x', key: 'y', normalize: () => ({ value: null, issues: [] }) }),
    /already owned by domain "a"/,
  );
});

// ── Provider-registry write validation through administration (ADR-0016) ────

test('administration: EVERY provider-selection domain rejects configured-but-unregistered values — no silent fallback', () => {
  const { db, configService } = fixture();
  // Composition-supplied structured context: the registries' keys, exactly
  // as server/handoff/app.js wires them.
  const admin = createAdministrationService({
    configService, configDb: db, clock: fixedClock(T0),
    identityProviderKeys: () => ['dev-user'],
    validationContext: () => ({
      identityProviderKeys: ['dev-user'],
      conversationProviderKeys: ['elevenlabs'],
      notificationProviderKeys: ['graph-email'],
      integrationProviderKeys: ['demo-integration'],
      integrationTypes: ['demo-record-sync', 'demo-calendar-sync'],
    }),
  });
  const ctx = { actor: 'admin-ada', organizationKey: FIRM };

  const cases = [
    ['identity-provider', { provider: 'okta' }, { provider: 'dev-user' }],
    ['conversation-provider', { provider: 'vapi' }, { provider: 'elevenlabs' }],
    ['notification-provider', { provider: 'sendgrid' }, { provider: 'graph-email' }],
    ['integration-providers',
      { providers: { 'demo-record-sync': 'clio' } },
      { providers: { 'demo-record-sync': 'demo-integration' } }],
  ];
  for (const [area, unregistered, registered] of cases) {
    assert.throws(() => admin.apply(area, ctx, unregistered),
      (e) => e.code === 'validation_error' || e.name === 'ValidationError',
      `${area}: unregistered selection must be rejected at administration time`);
    const ok = admin.apply(area, ctx, registered);
    assert.ok(ok.version >= 1, `${area}: registered selection persists`);
  }

  // The integration domain also rejects unknown CAPABILITIES.
  assert.throws(() => admin.apply('integration-providers', ctx,
    { providers: { 'billing-sync': 'demo-integration' } }, 1),
    (e) => e.code === 'validation_error' || e.name === 'ValidationError');
});

// ── Live consumption through administration ─────────────────────────────────

test('framework: an administered write is consumed live through the framework read path', () => {
  const { db, configService } = fixture();
  const admin = createAdministrationService({
    configService, configDb: db, clock: fixedClock(T0), identityProviderKeys: () => ['dev-user'],
  });
  const ctx = { actor: 'admin-ada', organizationKey: FIRM };

  const out = admin.apply('scheduling-policy', ctx, { preferredTimeOfDay: 'Morning' });
  assert.equal(out.version, 1);
  assert.deepEqual(out.result, { preferredTimeOfDay: 'morning' }, 'the CANONICAL normalized document is what persisted');
  assert.deepEqual(resolveSchedulingPolicy(configService, FIRM).policy, { preferredTimeOfDay: 'morning' }, 'live on the next read');

  // Optimistic concurrency still guards every domain area.
  assert.throws(() => admin.apply('scheduling-policy', ctx, { preferredTimeOfDay: 'afternoon' }, 0),
    (e) => e.code === 'configuration_version_conflict');

  // The new registry-generated areas work end to end too.
  const conv = admin.apply('conversation-provider', ctx, { provider: 'elevenlabs', agentId: 'agent_public' });
  assert.deepEqual(conv.result, { provider: 'elevenlabs', agentId: 'agent_public' });
  assert.throws(() => admin.apply('notification-provider', ctx, { provider: '' }), (e) => e.status === 400);
});
