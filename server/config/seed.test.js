'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, run, loadSeedDocument } = require('./seed');
const { openDatabase } = require('./db');
const { createConfigService } = require('./service');

const EXAMPLE_FILE = path.join(__dirname, 'data', 'martinson-beason.example.json');

test('loadSeedDocument parses a valid file and rejects invalid JSON', () => {
  const doc = loadSeedDocument(EXAMPLE_FILE);
  assert.equal(doc.organization.key, 'martinson-beason');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-config-seed-'));
  try {
    const badFile = path.join(dir, 'bad.json');
    fs.writeFileSync(badFile, '{ not json');
    assert.throws(() => loadSeedDocument(badFile), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs requires both --db and --file', () => {
  assert.deepEqual(
    parseArgs(['--db', 'x.db', '--file', 'y.json']),
    { dbPath: 'x.db', filePath: 'y.json' },
  );
  assert.throws(() => parseArgs(['--db', 'x.db']), /--db and --file are required/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown or incomplete argument/);
});

test('run migrates a fresh file database, imports the document, and is re-runnable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-config-seed-'));
  const dbPath = path.join(dir, 'config.db');
  try {
    const tree = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
    const first = run({ dbPath, filePath: EXAMPLE_FILE });
    assert.deepEqual(first.migrationsApplied, ['0001-initial', '0002-administration', '0003-users']);
    assert.equal(first.organization, 'martinson-beason');
    assert.equal(first.counts.providers, tree.providers.length);

    // Re-running is an upsert on an already-migrated database.
    const second = run({ dbPath, filePath: EXAMPLE_FILE });
    assert.deepEqual(second.migrationsApplied, []);
    assert.equal(second.organization, 'martinson-beason');

    // The data really is in the file.
    const db = openDatabase({ path: dbPath });
    const service = createConfigService({ db });
    assert.equal(
      service.providers.get('martinson-beason', 'clay-martinson').name,
      'Clay Martinson',
    );
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run rejects a file that is not valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-config-seed-'));
  try {
    const badFile = path.join(dir, 'bad.json');
    fs.writeFileSync(badFile, '{ not json');
    assert.throws(
      () => run({ dbPath: path.join(dir, 'config.db'), filePath: badFile }),
      /not valid JSON/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
