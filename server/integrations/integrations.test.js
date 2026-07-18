'use strict';

/**
 * GuideHerd Integration Contract tests (ADR-0020).
 *
 * Covers the request contract (strict allowlist, key grammar, safe facts),
 * the provider registry (loud on misconfiguration), the delivery claim
 * machine (shared contract suite, in-memory leg — the PostgreSQL leg runs
 * in server/operational/operational.test.js against the same suite), the
 * service pipeline (dark by default, configuration-selected provider,
 * idempotent under at-least-once redelivery, duplication-safe retry
 * classification, correlation-aware telemetry with no fact leakage), the
 * configuration domain, and application composition. Deterministic: fixed
 * clocks, synthetic data, no network, no credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixedClock } = require('../handoff/clock');
const { STALE_CLAIM_MS } = require('../handoff/store');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createTelemetry } = require('../telemetry/telemetry');
const { readDomain, validateDomain } = require('../configuration/framework');

const { INTEGRATION_TYPES, validateIntegrationRequest, createIntegrationProviderRegistry } = require('./contract');
const { createInMemoryIntegrationDeliveryStore } = require('./delivery-store');
const { runIntegrationDeliveryStoreContractSuite } = require('./delivery-contract-suite');
const { createIntegrationService } = require('./service');
const { createDemoIntegrationProvider, PROVIDER_KEY } = require('./demo-provider');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const FIRM = 'martinson-beason';

function configServiceWithFirm() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: 'America/Chicago' });
  return configService;
}

function makeRequest(overrides = {}) {
  return {
    type: 'demo-record-sync',
    organizationKey: FIRM,
    integrationKey: `demo-record-sync:sess-${Math.abs(overrides.n ?? 1)}`,
    facts: { sessionId: 'sess-1', outcome: 'booked' },
    ...overrides,
  };
}

function capture() {
  const lines = [];
  return { lines, telemetry: createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) }) };
}

// ── Request contract ────────────────────────────────────────────────────────

test('contract: a valid request canonicalizes; strict allowlist rejects unknown keys', () => {
  const canonical = validateIntegrationRequest(makeRequest());
  assert.deepEqual(canonical, {
    type: 'demo-record-sync',
    organizationKey: FIRM,
    integrationKey: 'demo-record-sync:sess-1',
    facts: { sessionId: 'sess-1', outcome: 'booked' },
  });
  assert.throws(() => validateIntegrationRequest({ ...makeRequest(), extra: 1 }), /unknown key extra/);
  assert.throws(() => validateIntegrationRequest({ ...makeRequest(), type: 'nope' }), /unknown type/);
  assert.throws(() => validateIntegrationRequest(null), /not an object/);
});

test('contract: the idempotency-key grammar <type>:<logical-event-id> is enforced', () => {
  assert.throws(() => validateIntegrationRequest(makeRequest({ integrationKey: 'no-colon' })), /grammar|must follow/);
  assert.throws(() => validateIntegrationRequest(makeRequest({ integrationKey: 'other-type:sess-1' })),
    /namespaced by its type/);
  assert.throws(() => validateIntegrationRequest(makeRequest({ integrationKey: 'demo-record-sync:' })), /must follow/);
  // The documented grammar accepts nested logical ids.
  const ok = validateIntegrationRequest(makeRequest({ integrationKey: 'demo-record-sync:sess-1:v2' }));
  assert.equal(ok.integrationKey, 'demo-record-sync:sess-1:v2');
});

test('contract: facts are per-type allowlisted, bounded scalars — customer payloads cannot ride along', () => {
  // PII-shaped keys are rejected because they are not in the type's allowlist.
  for (const bad of ['email', 'fullName', 'phone', 'notes']) {
    assert.throws(() => validateIntegrationRequest(makeRequest({ facts: { [bad]: 'x' } })),
      new RegExp(`fact ${bad} is not allowed`));
  }
  // Non-scalar and oversized values are rejected even for allowlisted keys.
  assert.throws(() => validateIntegrationRequest(makeRequest({ facts: { sessionId: { deep: true } } })), /bounded scalar/);
  assert.throws(() => validateIntegrationRequest(makeRequest({ facts: { sessionId: 'x'.repeat(300) } })), /bounded scalar/);
  // The catalog documents its own allowlist.
  assert.ok(INTEGRATION_TYPES['demo-record-sync'].facts.includes('sessionId'));
});

// ── Provider registry ───────────────────────────────────────────────────────

test('registry: registers and resolves providers; unknown keys fail loudly, never a silent substitute', () => {
  const registry = createIntegrationProviderRegistry();
  registry.register(createDemoIntegrationProvider());
  assert.ok(registry.resolve(PROVIDER_KEY));
  assert.deepEqual(registry.keys(), [PROVIDER_KEY]);
  assert.throws(() => registry.resolve('filevine'),
    (e) => e.code === 'integration_provider_unavailable' && e.category === 'permanent_internal_failure');
  assert.throws(() => registry.register({ providerKey: 'x' }), TypeError);
});

// ── Delivery claim machine (shared contract suite, in-memory leg) ───────────

runIntegrationDeliveryStoreContractSuite('memory',
  async ({ clock }) => createInMemoryIntegrationDeliveryStore({ clock }));

// ── Service pipeline ────────────────────────────────────────────────────────

function makeService({ configService = null, behavior, clock = fixedClock(T0) } = {}) {
  const { lines, telemetry } = capture();
  const registry = createIntegrationProviderRegistry();
  const provider = createDemoIntegrationProvider({ behavior: behavior || (() => 'complete'), telemetry });
  registry.register(provider);
  const deliveryStore = createInMemoryIntegrationDeliveryStore({ clock });
  const service = createIntegrationService({ registry, deliveryStore, configService, telemetry });
  return { service, provider, deliveryStore, lines, clock };
}

test('service: DARK BY DEFAULT — no configured provider yields the controlled not-configured result, no provider call', async () => {
  const configService = configServiceWithFirm(); // org exists; no integration config
  const { service, provider, deliveryStore, lines } = makeService({ configService });

  const result = await service.request(makeRequest(), { correlationId: 'gh-c1' });
  assert.deepEqual(result, { status: 'not-configured' });
  assert.equal(provider.deliveries().length, 0, 'the provider was never called');
  assert.equal((await deliveryStore.get('demo-record-sync:sess-1')).status, 'not-configured');
  const event = lines.find((l) => l.event === 'guideherd.integration.delivery_failed');
  assert.equal(event.code, 'provider_not_configured');
  assert.equal(event.level, 'warn', 'dark is a controlled condition, not an error');
});

test('service: a configured organization delivers through the selected provider, exactly once per key', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: PROVIDER_KEY });
  const { service, provider, lines } = makeService({ configService });

  const first = await service.request(makeRequest(), { correlationId: 'gh-c2', sessionId: 'sess-1' });
  assert.deepEqual(first, { status: 'completed' });
  assert.equal(provider.deliveries().length, 1);

  // At-least-once redelivery (outbox retry, second instance): suppressed
  // without a second provider call — completed is final.
  const dup = await service.request(makeRequest(), { correlationId: 'gh-c2' });
  assert.deepEqual(dup, { status: 'suppressed', suppressedBy: 'completed' });
  assert.equal(provider.deliveries().length, 1, 'no duplicate external effect');

  const delivered = lines.find((l) => l.event === 'guideherd.integration.delivered');
  assert.equal(delivered.provider, PROVIDER_KEY);
  assert.equal(delivered.correlationId, 'gh-c2');
  assert.equal(delivered.integrationKey, 'demo-record-sync:sess-1');
  const suppressed = lines.find((l) => l.event === 'guideherd.integration.suppressed');
  assert.equal(suppressed.code, 'already_completed');
});

test('service: configured-but-unregistered fails LOUDLY and re-claimably (ADR-0007 §6)', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: 'clio' }); // not registered
  const { service, deliveryStore, lines } = makeService({ configService });

  const result = await service.request(makeRequest(), { correlationId: 'gh-c3' });
  assert.deepEqual(result, { status: 'failed' });
  const event = lines.find((l) => l.event === 'guideherd.integration.delivery_failed');
  assert.equal(event.code, 'integration_provider_unavailable');
  assert.equal(event.level, 'error');
  assert.equal(event.provider, 'clio');

  // failed is re-claimable: once the deployment registers the provider,
  // recovery delivers without duplication.
  assert.equal((await deliveryStore.claim('demo-record-sync:sess-1')).claimed, true);
});

test('service: duplication-safe retry classification — transient refusals retry inside the provider, permanent ones never do', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: PROVIDER_KEY });

  // Transient (provably not accepted): bounded retries succeed, one claim.
  {
    const { service, provider, lines } = makeService({ configService, behavior: () => 'retryable-then-complete' });
    const result = await service.request(makeRequest(), {});
    assert.equal(result.status, 'completed');
    assert.equal(provider.deliveries()[0].attempts, 3, 'two transient refusals, then acceptance');
    assert.ok(lines.some((l) => l.event === 'guideherd.retry.attempted'));
  }
  // Permanent / acceptance-ambiguous: exactly one attempt, failed result.
  {
    const { service, provider, lines } = makeService({ configService, behavior: () => 'nonretryable' });
    const result = await service.request(makeRequest({ integrationKey: 'demo-record-sync:sess-perm' }), {});
    assert.equal(result.status, 'failed');
    assert.equal(provider.deliveries().length, 0);
    assert.ok(!lines.some((l) => l.event === 'guideherd.retry.attempted'), 'never blind-retried');
  }
  // Retries exhausted: failed, re-claimable for later recovery.
  {
    const { service, deliveryStore } = makeService({ configService, behavior: () => 'retryable-always' });
    const result = await service.request(makeRequest({ integrationKey: 'demo-record-sync:sess-exh' }), {});
    assert.equal(result.status, 'failed');
    assert.equal((await deliveryStore.claim('demo-record-sync:sess-exh')).claimed, true, 'bounded, then re-claimable');
  }
});

test('service: a provider returning nonsense fails closed', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: PROVIDER_KEY });
  const { service, deliveryStore } = makeService({ configService, behavior: () => 'nonsense' });
  const result = await service.request(makeRequest(), {});
  assert.deepEqual(result, { status: 'failed' });
  assert.equal((await deliveryStore.get('demo-record-sync:sess-1')).status, 'failed');
});

test('service: a stale pending claim (claimant crashed mid-delivery) is recovered after the stale window', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: PROVIDER_KEY });
  const clock = fixedClock(T0);
  const { service, deliveryStore, provider } = makeService({ configService, clock });

  await deliveryStore.claim('demo-record-sync:sess-1'); // simulated crash: claimed, never recorded
  assert.equal((await service.request(makeRequest(), {})).status, 'suppressed', 'fresh pending suppresses');
  clock.set(T0 + STALE_CLAIM_MS);
  assert.equal((await service.request(makeRequest(), {})).status, 'completed', 'stale claim recovered');
  assert.equal(provider.deliveries().length, 1);
});

test('service: telemetry carries correlation and identifiers — never fact values', async () => {
  const configService = configServiceWithFirm();
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: PROVIDER_KEY });
  const { service, lines } = makeService({ configService });
  await service.request(makeRequest({ facts: { sessionId: 'sess-1', outcome: 'booked', attorneyId: 'clay-martinson' } }),
    { correlationId: 'gh-c9' });
  const serialized = JSON.stringify(lines);
  assert.ok(serialized.includes('gh-c9'));
  assert.ok(serialized.includes('demo-record-sync:sess-1'));
  assert.ok(!serialized.includes('clay-martinson'), 'fact values never reach telemetry');
});

// ── Configuration domain ────────────────────────────────────────────────────

test('domain: integration-provider is dark by default and write-strict', () => {
  const configService = configServiceWithFirm();

  // Read default: no provider — the dark posture.
  assert.deepEqual(readDomain(configService, 'integration-provider', FIRM).value, { provider: null });

  // Reads are fail-safe: a damaged stored value degrades to the default.
  configService.settings.set(FIRM, 'integrations', 'provider', { provider: 42 });
  const damaged = readDomain(configService, 'integration-provider', FIRM);
  assert.deepEqual(damaged.value, { provider: null });
  assert.ok(damaged.issues.length > 0);

  // Writes are strict: unknown fields and unregistered providers are refused.
  assert.equal(validateDomain('integration-provider', { provider: PROVIDER_KEY, extra: 1 }, {}).ok, false);
  const unregistered = validateDomain('integration-provider', { provider: 'clio' },
    { integrationProviderKeys: [PROVIDER_KEY] });
  assert.equal(unregistered.ok, false);
  const registered = validateDomain('integration-provider', { provider: PROVIDER_KEY },
    { integrationProviderKeys: [PROVIDER_KEY] });
  assert.equal(registered.ok, true);
  // Explicitly returning to dark is always a valid write.
  assert.equal(validateDomain('integration-provider', { provider: null },
    { integrationProviderKeys: [PROVIDER_KEY] }).ok, true);
});

// ── Application composition ─────────────────────────────────────────────────

test('composition: createApp exposes the Integration Contract and its capability; nothing else changes', async () => {
  const { createApp } = require('../handoff/app');
  const app = createApp({ clock: fixedClock(T0), configService: configServiceWithFirm() });

  assert.ok(app.integrations.service, 'service exposed');
  assert.deepEqual(app.integrations.registry.keys(), [PROVIDER_KEY], 'demo provider registered');
  assert.ok(app.integrations.deliveryStore.claim, 'delivery store exposed');

  const health = await app.operations.health();
  const capability = health.find((h) => h.capability === 'integration-provider');
  assert.equal(capability.status, 'available', 'deployment capability visible to operations');

  // The sibling contracts are untouched by composition.
  assert.ok(app.notifications.service && app.outbox && app.scheduler);
});

test('composition: an end-to-end request through the composed app is dark by default, live once configured', async () => {
  const { createApp } = require('../handoff/app');
  const configService = configServiceWithFirm();
  const app = createApp({ clock: fixedClock(T0), configService });

  const dark = await app.integrations.service.request(makeRequest(), { correlationId: 'gh-e2e' });
  assert.equal(dark.status, 'not-configured');

  configService.settings.set(FIRM, 'integrations', 'provider', { provider: PROVIDER_KEY });
  const live = await app.integrations.service.request(
    makeRequest({ integrationKey: 'demo-record-sync:sess-live' }), { correlationId: 'gh-e2e' });
  assert.equal(live.status, 'completed', 'configuration is live — the very next request uses it');
});
