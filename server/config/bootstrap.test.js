'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveSeedMode, seedOnBoot, describeAuthority } = require('./bootstrap');
const { openDatabase } = require('./db');
const { migrate } = require('./migrate');
const { createConfigService } = require('./service');

const EXAMPLE_FILE = path.join(__dirname, 'data', 'martinson-beason.example.json');

/** Fresh service on a temp file database, plus a scratch dir for documents. */
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-config-bootstrap-'));
  const db = openDatabase({ path: path.join(dir, 'config.db') });
  migrate(db);
  const service = createConfigService({ db });
  const logs = [];
  return {
    dir,
    service,
    logs,
    log: (entry) => logs.push(entry),
    writeDoc(name, value) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
      return p;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('resolveSeedMode: defaults to bootstrap, accepts always, rejects everything else', () => {
  assert.equal(resolveSeedMode(undefined), 'bootstrap');
  assert.equal(resolveSeedMode(''), 'bootstrap');
  assert.equal(resolveSeedMode('  Bootstrap '), 'bootstrap');
  assert.equal(resolveSeedMode('ALWAYS'), 'always');
  assert.throws(() => resolveSeedMode('sometimes'), /GUIDEHERD_SEED_MODE must be one of bootstrap\|always/);
  assert.throws(() => resolveSeedMode('true'), /got "true"/);
});

test('seedOnBoot: no seed file means no action in either mode', () => {
  const h = harness();
  try {
    for (const mode of ['bootstrap', 'always']) {
      assert.deepEqual(seedOnBoot({ configService: h.service, filePath: undefined, mode, log: h.log }), { action: 'none' });
    }
    assert.equal(h.logs.length, 0);
    assert.equal(h.service.organizations.list().length, 0);
  } finally { h.cleanup(); }
});

test('bootstrap mode: fresh store imports the document exactly as before', () => {
  const h = harness();
  try {
    const result = seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'bootstrap', log: h.log });
    assert.equal(result.action, 'imported');
    assert.equal(result.organization, 'martinson-beason');
    assert.ok(result.counts);
    assert.ok(h.service.organizations.list().some((o) => o.key === 'martinson-beason'));
  } finally { h.cleanup(); }
});

test('bootstrap mode: an existing organization is never overwritten — live edits survive a reboot', () => {
  const h = harness();
  try {
    seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'bootstrap', log: h.log });
    // A live administration-style edit after bootstrap.
    h.service.organizations.update('martinson-beason', { displayName: 'Edited Live Name' });

    // Simulated restart: same seed file, same mode.
    const second = seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'bootstrap', log: h.log });
    assert.deepEqual(second, { action: 'skipped', organization: 'martinson-beason' });
    assert.equal(h.service.organizations.get('martinson-beason').displayName, 'Edited Live Name');

    // The skip is loud and names the organization.
    const skip = h.logs.find((e) => /bootstrap skipped/i.test(e.message));
    assert.ok(skip);
    assert.equal(skip.organization, 'martinson-beason');
    assert.equal(skip.level, 'info');
  } finally { h.cleanup(); }
});

test('bootstrap mode: a CHANGED seed document is inert once the organization exists', () => {
  const h = harness();
  try {
    seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'bootstrap', log: h.log });
    const stale = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
    stale.organization.displayName = 'Stale Git Copy';
    const staleFile = h.writeDoc('stale.json', stale);

    const result = seedOnBoot({ configService: h.service, filePath: staleFile, mode: 'bootstrap', log: h.log });
    assert.equal(result.action, 'skipped');
    assert.notEqual(h.service.organizations.get('martinson-beason').displayName, 'Stale Git Copy');
  } finally { h.cleanup(); }
});

test('always mode: re-imports every boot, overwriting live edits, with a loud warning', () => {
  const h = harness();
  try {
    seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'always', log: h.log });
    h.service.organizations.update('martinson-beason', { displayName: 'Edited Live Name' });

    const second = seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'always', log: h.log });
    assert.equal(second.action, 'imported');
    // The documented (and now explicit) overwrite behavior.
    assert.notEqual(h.service.organizations.get('martinson-beason').displayName, 'Edited Live Name');

    const warns = h.logs.filter((e) => e.level === 'warn' && /overwritten at every boot/.test(e.message));
    assert.equal(warns.length, 2); // one per boot
  } finally { h.cleanup(); }
});

test('multi-tenant: bootstrapping a second organization leaves the first untouched', () => {
  const h = harness();
  try {
    seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'bootstrap', log: h.log });
    h.service.organizations.update('martinson-beason', { displayName: 'Edited Live Name' });

    const firmB = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
    firmB.organization.key = 'second-firm';
    firmB.organization.name = 'Second Firm';
    const fileB = h.writeDoc('firm-b.json', firmB);

    const result = seedOnBoot({ configService: h.service, filePath: fileB, mode: 'bootstrap', log: h.log });
    assert.equal(result.action, 'imported');
    assert.equal(result.organization, 'second-firm');
    assert.equal(h.service.organizations.get('martinson-beason').displayName, 'Edited Live Name');
    assert.equal(h.service.organizations.list().length, 2);
  } finally { h.cleanup(); }
});

test('an unreadable or invalid document throws (boot refuses to start), even when initialized', () => {
  const h = harness();
  try {
    seedOnBoot({ configService: h.service, filePath: EXAMPLE_FILE, mode: 'bootstrap', log: h.log });
    const badFile = h.writeDoc('bad.json', '{ not json');
    // The organization key cannot be trusted from an unparseable document,
    // so this fails loudly rather than guessing "skip".
    assert.throws(() => seedOnBoot({ configService: h.service, filePath: badFile, mode: 'bootstrap', log: h.log }), /not valid JSON/);
    assert.throws(() => seedOnBoot({ configService: h.service, filePath: path.join(h.dir, 'missing.json'), mode: 'bootstrap', log: h.log }), /ENOENT/);
  } finally { h.cleanup(); }
});

test('a document with an invalid entity imports nothing (validate-first, one transaction)', () => {
  const h = harness();
  try {
    const tree = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
    tree.serviceAreas = 'not-an-array';
    const file = h.writeDoc('invalid-entity.json', tree);
    assert.throws(() => seedOnBoot({ configService: h.service, filePath: file, mode: 'bootstrap', log: h.log }));
    assert.equal(h.service.organizations.list().length, 0); // untouched
  } finally { h.cleanup(); }
});

test('a document without an organization key fails loudly in bootstrap mode', () => {
  const h = harness();
  try {
    const file = h.writeDoc('no-org.json', { locations: [] });
    assert.throws(() => seedOnBoot({ configService: h.service, filePath: file, mode: 'bootstrap', log: h.log }));
  } finally { h.cleanup(); }
});

test('describeAuthority: live is claimed only when durability is evidenced', () => {
  // always mode: edits are overwritten — seed-managed.
  assert.deepEqual(
    describeAuthority({ filePath: '/x.json', mode: 'always', result: { action: 'imported' } }),
    { mode: 'seed-managed', seedOnBoot: true, lastBootImport: 'imported' },
  );
  // bootstrap + skipped: the store pre-existed this boot — durable, live.
  assert.deepEqual(
    describeAuthority({ filePath: '/x.json', mode: 'bootstrap', result: { action: 'skipped' } }),
    { mode: 'live', seedOnBoot: true, lastBootImport: 'skipped' },
  );
  // bootstrap + imported THIS boot: first boot and ephemeral-filesystem
  // deployments are indistinguishable from inside one boot, so no
  // durability is promised — a restart that skips proves it.
  assert.deepEqual(
    describeAuthority({ filePath: '/x.json', mode: 'bootstrap', result: { action: 'imported' } }),
    { mode: 'bootstrap-imported', seedOnBoot: true, lastBootImport: 'imported' },
  );
  // No seed file at all: the store is the only source there is — live.
  assert.deepEqual(
    describeAuthority({ filePath: undefined, mode: 'bootstrap', result: { action: 'none' } }),
    { mode: 'live', seedOnBoot: false, lastBootImport: 'none' },
  );
  // Boot failed before seeding resolved (fatal path): result null.
  assert.deepEqual(
    describeAuthority({ filePath: '/x.json', mode: null, result: null }),
    { mode: 'live', seedOnBoot: true, lastBootImport: 'none' },
  );
});

test('seed import gate (ADR-0016): settings that fail domain validation — including cross-entity mapping rules — refuse to import', () => {
  const h = harness();
  try {
    const seed = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
    // The real example seed passes the gate.
    const ok = seedOnBoot({ configService: h.service, filePath: h.writeDoc('ok.json', seed), mode: 'bootstrap', log: h.log });
    assert.equal(ok.action, 'imported');

    // A mapping to a NONEXISTENT attorney refuses to boot.
    const ghost = structuredClone(seed);
    ghost.organization.key = 'ghost-firm';
    ghost.settings.find((s) => s.key === 'calcom-availability').value.attorneyEventTypes = { 'no-such-attorney': 123 };
    assert.throws(
      () => seedOnBoot({ configService: h.service, filePath: h.writeDoc('ghost.json', ghost), mode: 'bootstrap', log: h.log }),
      /calcom-availability.*no-such-attorney.*unknown attorney/,
    );

    // A mapping to an INACTIVE routing group refuses to boot.
    const inactive = structuredClone(seed);
    inactive.organization.key = 'inactive-firm';
    inactive.routingGroups.find((g) => g.key === 'probate').active = false;
    assert.throws(
      () => seedOnBoot({ configService: h.service, filePath: h.writeDoc('inactive.json', inactive), mode: 'bootstrap', log: h.log }),
      /routingGroupEventTypes\.probate.*not active/,
    );

    // An UNSAFE integer event type refuses to boot (normalize is strict at import).
    const unsafe = structuredClone(seed);
    unsafe.organization.key = 'unsafe-firm';
    unsafe.settings.find((s) => s.key === 'calcom-availability').value.eventTypeId = 2 ** 53;
    assert.throws(
      () => seedOnBoot({ configService: h.service, filePath: h.writeDoc('unsafe.json', unsafe), mode: 'bootstrap', log: h.log }),
      /eventTypeId must be a positive safe integer/,
    );
  } finally { h.cleanup(); }
});
