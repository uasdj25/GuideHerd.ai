'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('./db');
const { migrate } = require('./migrate');
const { MigrationError } = require('./errors');
const { fixedClock } = require('./clock');

const T0 = Date.UTC(2026, 6, 13, 12, 0, 0);

function tableNames(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => row.name);
}

test('migrate applies the initial schema to a fresh database', () => {
  const db = openDatabase();
  const applied = migrate(db, { clock: fixedClock(T0) });

  assert.deepEqual(applied, ['0001-initial', '0002-administration', '0003-users']);
  const tables = tableNames(db);
  for (const expected of [
    'organizations', 'locations', 'office_hours', 'providers',
    'service_areas', 'consultation_types', 'routing_groups',
    'routing_group_members', 'settings', 'schema_migrations', 'users',
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }

  const recorded = db.prepare('SELECT version, applied_at FROM schema_migrations').all();
  assert.equal(recorded.length, 3);
  assert.equal(recorded[0].version, '0001-initial');
  assert.equal(recorded[1].version, '0002-administration');
  assert.equal(recorded[2].version, '0003-users');
  assert.equal(recorded[0].applied_at, new Date(T0).toISOString());
  db.close();
});

test('migrate is idempotent: a second run applies nothing', () => {
  const db = openDatabase();
  migrate(db, { clock: fixedClock(T0) });
  const secondRun = migrate(db, { clock: fixedClock(T0) });
  assert.deepEqual(secondRun, []);
  db.close();
});

test('a failing migration rolls back completely and reports its version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-config-migrate-'));
  try {
    fs.writeFileSync(
      path.join(dir, '0001-bad.sql'),
      'CREATE TABLE will_roll_back (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;\n',
    );
    const db = openDatabase();
    assert.throws(
      () => migrate(db, { migrationsDir: dir, clock: fixedClock(T0) }),
      (err) => err instanceof MigrationError && err.version === '0001-bad',
    );
    // The partial CREATE TABLE must have been rolled back.
    assert.ok(!tableNames(db).includes('will_roll_back'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-matching filenames are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-config-migrate-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a migration');
    fs.writeFileSync(path.join(dir, '01-too-short.sql'), 'CREATE TABLE nope (id INTEGER);');
    const db = openDatabase();
    assert.deepEqual(migrate(db, { migrationsDir: dir, clock: fixedClock(T0) }), []);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
