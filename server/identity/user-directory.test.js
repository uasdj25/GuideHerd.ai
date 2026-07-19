'use strict';

/**
 * User Directory tests (#65): record shape (never credential material),
 * validation, duplicate protection, credential-hash login resolution,
 * counts — plus the dev-user provider consuming the directory: store
 * users authenticate through the same contract, deactivated users fail
 * uniformly, and env-var bootstrap users keep working alongside.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { fixedClock } = require('../handoff/clock');
const { createUserDirectory } = require('./user-directory');
const { createDevUserProvider } = require('./dev-user-provider');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const ORG = 'martinson-beason';

const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

function makeDirectory() {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  return createUserDirectory({ db, clock: fixedClock(T0) });
}

test('directory: create/list/get expose records with NO credential material', () => {
  const directory = makeDirectory();
  const record = directory.create(ORG, { subject: 'jane-doe', displayName: 'Jane Doe', roles: ['receptionist'] }, sha256('a-credential-0123456789'));
  assert.deepEqual(record, {
    subject: 'jane-doe', displayName: 'Jane Doe', roles: ['receptionist'],
    active: true, hasCredential: true,
    createdAt: '2026-07-12T15:15:00.000Z', updatedAt: '2026-07-12T15:15:00.000Z',
  });
  assert.equal(JSON.stringify(directory.list(ORG)).includes(sha256('a-credential-0123456789')), false);
  assert.equal(directory.get(ORG, 'nobody'), null);
  assert.equal(directory.get('other-org', 'jane-doe'), null, 'organization-scoped lookups');
});

test('directory: validation — subject grammar, roles, display name; duplicates rejected', () => {
  const directory = makeDirectory();
  assert.throws(() => directory.create(ORG, { subject: 'Bad Subject!', roles: ['receptionist'] }), (e) => e.status === 400);
  assert.throws(() => directory.create(ORG, { subject: 'ok-subject', roles: [] }), (e) => e.status === 400);
  assert.throws(() => directory.create(ORG, { subject: 'ok-subject', displayName: 'x'.repeat(200), roles: ['operator'] }), (e) => e.status === 400);
  directory.create(ORG, { subject: 'ok-subject', roles: ['operator'] });
  assert.throws(() => directory.create(ORG, { subject: 'ok-subject', roles: ['operator'] }), (e) => e.status === 409);
  // Same subject in ANOTHER organization is a different user.
  directory.create('other-org', { subject: 'ok-subject', roles: ['operator'] });
});

test('directory: credential-hash resolution, rotation, deactivation, and counts', () => {
  const directory = makeDirectory();
  directory.create(ORG, { subject: 'op-one', roles: ['operator', 'administrator'] }, sha256('credential-one-0123456789'));
  directory.create(ORG, { subject: 'no-login', roles: ['receptionist'] }); // no credential

  const found = directory.findByCredentialHash(sha256('credential-one-0123456789'));
  assert.equal(found.subject, 'op-one');
  assert.equal(found.organizationKey, ORG);
  assert.equal(directory.findByCredentialHash(sha256('wrong')), null);

  directory.setCredentialHash(ORG, 'op-one', sha256('credential-two-0123456789'));
  assert.equal(directory.findByCredentialHash(sha256('credential-one-0123456789')), null, 'rotation kills the old credential');
  assert.equal(directory.findByCredentialHash(sha256('credential-two-0123456789')).subject, 'op-one');

  assert.equal(directory.countActiveAdministrators(ORG), 1);
  assert.equal(directory.countCredentialed(), 1, 'only active users with credentials can sign in');
  directory.setActive(ORG, 'op-one', false);
  assert.equal(directory.countActiveAdministrators(ORG), 0);
  assert.equal(directory.countCredentialed(), 0);
});

test('provider: store-backed users authenticate through the same contract; deactivation fails uniformly', async () => {
  const directory = makeDirectory();
  directory.create(ORG, { subject: 'store-user', displayName: 'Store User', roles: ['receptionist'] }, sha256('store-credential-0123456789'));

  const envUsers = JSON.stringify([
    { key: 'env-credential-0123456789', subject: 'env-user', organizationKey: ORG, roles: ['operator'] },
  ]);
  const provider = createDevUserProvider({ devUsersJson: envUsers, userDirectory: directory });
  assert.equal(provider.size(), 2, 'env + store users are both sign-in-capable');

  const claim = await provider.authenticateUser({ credential: 'store-credential-0123456789' });
  assert.deepEqual(claim, {
    subject: 'store-user', type: 'user', displayName: 'Store User',
    organizationKey: ORG, roles: ['receptionist'],
  });
  // Env bootstrap continues to work alongside.
  assert.equal((await provider.authenticateUser({ credential: 'env-credential-0123456789' })).subject, 'env-user');

  // Deactivated: exactly the same failure as an unknown credential.
  directory.setActive(ORG, 'store-user', false);
  const errors = [];
  for (const credential of ['store-credential-0123456789', 'totally-unknown-credential']) {
    try { await provider.authenticateUser({ credential }); } catch (e) { errors.push({ name: e.name, message: e.message }); }
  }
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0], errors[1], 'no account-state oracle at the login boundary');
});

test('provider: an empty env config with a populated directory is configured (503 only when BOTH are empty)', async () => {
  const directory = makeDirectory();
  const empty = createDevUserProvider({ devUsersJson: undefined, userDirectory: directory });
  await assert.rejects(() => empty.authenticateUser({ credential: 'anything-at-all-12345' }), (e) => e.name === 'IdentityNotConfiguredError');

  directory.create(ORG, { subject: 'only-store', roles: ['receptionist'] }, sha256('only-store-credential-123'));
  assert.equal((await empty.authenticateUser({ credential: 'only-store-credential-123' })).subject, 'only-store');
});
