'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('./db');
const { migrate } = require('./migrate');
const { createConfigService } = require('./service');
const {
  ValidationError,
  UnknownEntityError,
  DuplicateKeyError,
} = require('./errors');
const { fixedClock } = require('./clock');

const T0 = Date.UTC(2026, 6, 13, 12, 0, 0);

/** Fresh migrated :memory: service per test. */
function makeService() {
  const db = openDatabase();
  const clock = fixedClock(T0);
  migrate(db, { clock });
  return { db, clock, service: createConfigService({ db, clock }) };
}

function makeOrg(service, key = 'martinson-beason') {
  return service.organizations.create({
    key,
    name: 'Martinson & Beason, P.C.',
    displayName: 'Martinson & Beason',
    timezone: 'America/Chicago',
  });
}

// ── Organizations ────────────────────────────────────────────────────────────

test('organizations: create returns the public shape with defaults applied', () => {
  const { service } = makeService();
  const org = makeOrg(service);

  assert.equal(org.key, 'martinson-beason');
  assert.equal(org.name, 'Martinson & Beason, P.C.');
  assert.equal(org.timezone, 'America/Chicago');
  assert.equal(org.active, true);
  assert.equal(org.createdAt, new Date(T0).toISOString());
  assert.ok(!('id' in org), 'row ids must not leave the service');
});

test('organizations: duplicate key is rejected with a stable code', () => {
  const { service } = makeService();
  makeOrg(service);
  assert.throws(
    () => makeOrg(service),
    (err) => err instanceof DuplicateKeyError && err.code === 'duplicate_key' && err.status === 409,
  );
});

test('organizations: get of an unknown key throws unknown_organization', () => {
  const { service } = makeService();
  assert.throws(
    () => service.organizations.get('nobody'),
    (err) => err instanceof UnknownEntityError && err.code === 'unknown_organization' && err.status === 404,
  );
});

test('organizations: update patches fields, bumps updatedAt, and key is immutable', () => {
  const { service, clock } = makeService();
  makeOrg(service);
  clock.advance(60_000);

  const updated = service.organizations.update('martinson-beason', { displayName: 'M&B' });
  assert.equal(updated.displayName, 'M&B');
  assert.equal(updated.name, 'Martinson & Beason, P.C.');
  assert.equal(updated.updatedAt, new Date(T0 + 60_000).toISOString());
  assert.equal(updated.createdAt, new Date(T0).toISOString());

  assert.throws(
    () => service.organizations.update('martinson-beason', { key: 'renamed' }),
    (err) => err instanceof ValidationError
      && err.details.some((d) => d.field === 'key' && d.message === 'is immutable'),
  );
});

test('organizations: validation collects all problems in one error', () => {
  const { service } = makeService();
  assert.throws(
    () => service.organizations.create({ key: 'Bad Key!', name: '' }),
    (err) => err instanceof ValidationError
      && err.details.some((d) => d.field === 'key')
      && err.details.some((d) => d.field === 'name'),
  );
});

// ── Providers (representative of catalog entities) ──────────────────────────

test('providers: create, list, activeOnly filtering, and update', () => {
  const { service } = makeService();
  makeOrg(service);

  service.providers.create('martinson-beason', { key: 'clay-martinson', name: 'Clay Martinson' });
  service.providers.create('martinson-beason', { key: 'jane-beason', name: 'Jane Beason' });

  assert.equal(service.providers.list('martinson-beason').length, 2);

  service.providers.update('martinson-beason', 'jane-beason', { active: false });
  const active = service.providers.list('martinson-beason', { activeOnly: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].key, 'clay-martinson');

  const jane = service.providers.get('martinson-beason', 'jane-beason');
  assert.equal(jane.active, false);
});

test('providers: same key is allowed across different organizations', () => {
  const { service } = makeService();
  makeOrg(service, 'firm-a');
  makeOrg(service, 'firm-b');
  service.providers.create('firm-a', { key: 'clay-martinson', name: 'Clay Martinson' });
  // Must not throw: uniqueness is per organization.
  service.providers.create('firm-b', { key: 'clay-martinson', name: 'Clay Martinson' });
  assert.equal(service.providers.list('firm-b').length, 1);
});

test('providers: operations against an unknown organization throw unknown_organization', () => {
  const { service } = makeService();
  assert.throws(
    () => service.providers.create('nobody', { key: 'x', name: 'X' }),
    (err) => err.code === 'unknown_organization',
  );
});

test('service areas and consultation types: ordered by displayOrder', () => {
  const { service } = makeService();
  makeOrg(service);
  service.serviceAreas.create('martinson-beason', { key: 'family-law', name: 'Family Law', displayOrder: 2 });
  service.serviceAreas.create('martinson-beason', { key: 'personal-injury', name: 'Personal Injury', displayOrder: 1 });

  const areas = service.serviceAreas.list('martinson-beason');
  assert.deepEqual(areas.map((a) => a.key), ['personal-injury', 'family-law']);
});

// ── Locations & office hours ─────────────────────────────────────────────────

test('locations: create with office hours; setOfficeHours replaces all', () => {
  const { service } = makeService();
  makeOrg(service);

  const loc = service.locations.create('martinson-beason', {
    key: 'huntsville',
    name: 'Huntsville Office',
    city: 'Huntsville',
    region: 'AL',
    officeHours: [
      { dayOfWeek: 1, opens: '08:30', closes: '17:00' },
      { dayOfWeek: 2, opens: '08:30', closes: '17:00' },
    ],
  });
  assert.equal(loc.officeHours.length, 2);

  const updated = service.locations.setOfficeHours('martinson-beason', 'huntsville', [
    { dayOfWeek: 1, opens: '09:00', closes: '12:00' },
    { dayOfWeek: 1, opens: '13:00', closes: '17:00' }, // split shift
  ]);
  assert.deepEqual(updated.officeHours, [
    { dayOfWeek: 1, opens: '09:00', closes: '12:00' },
    { dayOfWeek: 1, opens: '13:00', closes: '17:00' },
  ]);
});

test('office hours: closes must be later than opens; dayOfWeek must be 0-6', () => {
  const { service } = makeService();
  makeOrg(service);
  service.locations.create('martinson-beason', { key: 'main', name: 'Main Office' });

  assert.throws(
    () => service.locations.setOfficeHours('martinson-beason', 'main', [
      { dayOfWeek: 1, opens: '17:00', closes: '08:30' },
    ]),
    (err) => err instanceof ValidationError
      && err.details.some((d) => d.field.endsWith('.closes')),
  );
  assert.throws(
    () => service.locations.setOfficeHours('martinson-beason', 'main', [
      { dayOfWeek: 7, opens: '08:30', closes: '17:00' },
    ]),
    (err) => err instanceof ValidationError
      && err.details.some((d) => d.field.endsWith('.dayOfWeek')),
  );
});

// ── Routing groups ───────────────────────────────────────────────────────────

test('routing groups: create with members, replace membership, cross-org keys rejected', () => {
  const { service } = makeService();
  makeOrg(service);
  service.providers.create('martinson-beason', { key: 'clay-martinson', name: 'Clay Martinson' });
  service.providers.create('martinson-beason', { key: 'jane-beason', name: 'Jane Beason' });
  service.serviceAreas.create('martinson-beason', { key: 'family-law', name: 'Family Law' });

  const group = service.routingGroups.create('martinson-beason', {
    key: 'family-law',
    name: 'Family Law',
    serviceArea: 'family-law',
    providers: ['clay-martinson'],
  });
  assert.deepEqual(group.providers, ['clay-martinson']);
  assert.equal(group.serviceArea, 'family-law');

  const updated = service.routingGroups.setProviders(
    'martinson-beason', 'family-law', ['clay-martinson', 'jane-beason'],
  );
  assert.deepEqual(updated.providers, ['clay-martinson', 'jane-beason']);

  // A provider key from a different organization is simply unknown here.
  makeOrg(service, 'firm-b');
  service.providers.create('firm-b', { key: 'someone-else', name: 'Someone Else' });
  assert.throws(
    () => service.routingGroups.setProviders('martinson-beason', 'family-law', ['someone-else']),
    (err) => err.code === 'unknown_provider',
  );
  // And the failed replace must not have destroyed the existing membership.
  const after = service.routingGroups.get('martinson-beason', 'family-law');
  assert.deepEqual(after.providers, ['clay-martinson', 'jane-beason']);
});

test('routing groups: creating with an unknown provider rolls the group back too', () => {
  const { service } = makeService();
  makeOrg(service);
  service.serviceAreas.create('martinson-beason', { key: 'ghosts', name: 'Ghosts' });
  assert.throws(
    () => service.routingGroups.create('martinson-beason', {
      key: 'ghost-group', name: 'Ghost Group', serviceArea: 'ghosts', providers: ['nobody'],
    }),
    (err) => err.code === 'unknown_provider',
  );
  // The transaction must have rolled back the group row itself.
  assert.throws(
    () => service.routingGroups.get('martinson-beason', 'ghost-group'),
    (err) => err.code === 'unknown_routing_group',
  );
});

test('routing groups: serviceArea is required and must exist; updates re-link it', () => {
  const { service } = makeService();
  makeOrg(service);
  service.serviceAreas.create('martinson-beason', { key: 'probate', name: 'Probate' });
  service.serviceAreas.create('martinson-beason', { key: 'estate-planning', name: 'Estate Planning' });

  assert.throws(
    () => service.routingGroups.create('martinson-beason', { key: 'g', name: 'G' }),
    (err) => err instanceof ValidationError
      && err.details.some((d) => d.field === 'serviceArea' && d.message === 'is required'),
  );
  assert.throws(
    () => service.routingGroups.create('martinson-beason', { key: 'g', name: 'G', serviceArea: 'nope' }),
    (err) => err.code === 'unknown_service_area',
  );

  service.routingGroups.create('martinson-beason', { key: 'g', name: 'G', serviceArea: 'probate' });
  const relinked = service.routingGroups.update('martinson-beason', 'g', { serviceArea: 'estate-planning' });
  assert.equal(relinked.serviceArea, 'estate-planning');
  assert.throws(
    () => service.routingGroups.update('martinson-beason', 'g', { serviceArea: 'nope' }),
    (err) => err.code === 'unknown_service_area',
  );
});

// ── Settings ─────────────────────────────────────────────────────────────────

test('settings: JSON round-trip, upsert, list by namespace, remove', () => {
  const { service } = makeService();
  makeOrg(service);

  const value = { greeting: 'Thank you for calling', pauses: [250, 500], enabled: true };
  const stored = service.settings.set('martinson-beason', 'voice', 'greeting', value);
  assert.deepEqual(stored.value, value);

  // Upsert replaces in place.
  service.settings.set('martinson-beason', 'voice', 'greeting', 'plain string');
  assert.equal(service.settings.get('martinson-beason', 'voice', 'greeting').value, 'plain string');

  service.settings.set('martinson-beason', 'scheduling', 'default-consultation-type', 'initial-consultation');
  assert.equal(service.settings.list('martinson-beason', 'voice').length, 1);
  assert.equal(service.settings.list('martinson-beason').length, 2);

  service.settings.remove('martinson-beason', 'voice', 'greeting');
  assert.throws(
    () => service.settings.get('martinson-beason', 'voice', 'greeting'),
    (err) => err.code === 'unknown_setting',
  );
  assert.throws(
    () => service.settings.remove('martinson-beason', 'voice', 'greeting'),
    (err) => err.code === 'unknown_setting',
  );
});

// ── Import / export ──────────────────────────────────────────────────────────

const EXAMPLE_FILE = path.join(__dirname, 'data', 'martinson-beason.example.json');

/**
 * Order-insensitive view of a configuration document: collections are sorted
 * by their stable keys so the example file may list entities in any order.
 */
function comparable(doc) {
  const byKey = (a, b) => (a.key < b.key ? -1 : 1);
  const bySetting = (a, b) => (a.namespace + '/' + a.key < b.namespace + '/' + b.key ? -1 : 1);
  return {
    ...doc,
    locations: [...(doc.locations ?? [])].sort(byKey),
    providers: [...(doc.providers ?? [])].sort(byKey),
    serviceAreas: [...(doc.serviceAreas ?? [])].sort(byKey),
    consultationTypes: [...(doc.consultationTypes ?? [])].sort(byKey),
    routingGroups: [...(doc.routingGroups ?? [])].sort(byKey),
    settings: [...(doc.settings ?? [])].sort(bySetting),
  };
}

test('import: the example document imports, and export round-trips it', () => {
  const { service } = makeService();
  const tree = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));

  const result = service.importOrganization(tree);
  assert.equal(result.organization, 'martinson-beason');
  assert.deepEqual(result.counts, {
    providers: tree.providers.length,
    locations: tree.locations.length,
    serviceAreas: tree.serviceAreas.length,
    consultationTypes: tree.consultationTypes.length,
    routingGroups: tree.routingGroups.length,
    settings: tree.settings.length,
  });

  const exported = service.exportOrganization('martinson-beason');
  assert.deepEqual(comparable(exported), comparable(tree));
});

test('import: re-import is a non-destructive upsert', () => {
  const { service } = makeService();
  const tree = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
  service.importOrganization(tree);

  // An entity not in the document survives a re-import untouched.
  service.providers.create('martinson-beason', { key: 'new-hire', name: 'New Hire' });

  // A changed name in the document is applied on re-import.
  tree.providers.find((p) => p.key === 'clay-martinson').displayName = 'Clay B. Martinson';
  service.importOrganization(tree);

  assert.equal(
    service.providers.get('martinson-beason', 'clay-martinson').displayName,
    'Clay B. Martinson',
  );
  assert.equal(service.providers.get('martinson-beason', 'new-hire').name, 'New Hire');
  assert.equal(service.providers.list('martinson-beason').length, tree.providers.length + 1);
});

test('import: a document referencing an unknown provider key fails atomically', () => {
  const { service } = makeService();
  assert.throws(
    () => service.importOrganization({
      organization: { key: 'firm-x', name: 'Firm X' },
      serviceAreas: [{ key: 'general', name: 'General' }],
      routingGroups: [{ key: 'g', name: 'G', serviceArea: 'general', providers: ['nobody'] }],
    }),
    (err) => err.code === 'unknown_provider',
  );
  // The whole transaction rolled back — the organization was not created.
  assert.throws(
    () => service.organizations.get('firm-x'),
    (err) => err.code === 'unknown_organization',
  );
});

test('import: validation failures reject before any write', () => {
  const { service } = makeService();
  assert.throws(
    () => service.importOrganization({
      organization: { key: 'firm-y', name: 'Firm Y' },
      providers: [{ key: 'Bad Key!', name: 'X' }],
    }),
    (err) => err instanceof ValidationError,
  );
  assert.throws(
    () => service.organizations.get('firm-y'),
    (err) => err.code === 'unknown_organization',
  );
});
