'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('./db');
const { migrate } = require('./migrate');
const { createConfigService } = require('./service');
const { getSchedulingOptions } = require('./options');
const { fixedClock } = require('./clock');
const { createApp } = require('../handoff/app');

const T0 = Date.UTC(2026, 6, 14, 12, 0, 0);
const EXAMPLE_FILE = path.join(__dirname, 'data', 'martinson-beason.example.json');

/** A config service seeded with the Martinson & Beason example document. */
function seededService() {
  const db = openDatabase();
  const clock = fixedClock(T0);
  migrate(db, { clock });
  const service = createConfigService({ db, clock });
  service.importOrganization(JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8')));
  return service;
}

// ── getSchedulingOptions (unit) ──────────────────────────────────────────────

test('options: practice areas come back in display order with GuideHerd naming', () => {
  const options = getSchedulingOptions(seededService(), 'martinson-beason');
  assert.deepEqual(
    options.practiceAreas.map((a) => a.id),
    ['auto-accidents', 'personal-injury', 'probate', 'criminal-defense',
     'real-estate', 'family-law', 'workers-compensation', 'military-law'],
  );
  assert.equal(options.practiceAreas[2].name, 'Probate & Estate Administration');
});

test('options: every practice area is keyed; an unrouted area maps to an empty list', () => {
  const options = getSchedulingOptions(seededService(), 'martinson-beason');
  for (const area of options.practiceAreas) {
    assert.ok(Array.isArray(options.attorneysByPracticeArea[area.id]), `missing key ${area.id}`);
  }
  // military-law is deliberately unrouted in the seed document.
  assert.deepEqual(options.attorneysByPracticeArea['military-law'], []);
  // A routed area lists its group's attorneys.
  assert.deepEqual(
    options.attorneysByPracticeArea['probate'].map((a) => a.id).sort(),
    ['clay-martinson', 'doug-martinson'],
  );
});

test('options: inactive attorneys and inactive groups are never offered', () => {
  const service = seededService();
  service.providers.update('martinson-beason', 'doug-martinson', { active: false });
  service.routingGroups.update('martinson-beason', 'family-law', { active: false });

  const options = getSchedulingOptions(service, 'martinson-beason');
  assert.deepEqual(
    options.attorneysByPracticeArea['probate'].map((a) => a.id),
    ['clay-martinson'],
  );
  assert.deepEqual(options.attorneysByPracticeArea['family-law'], []);
});

test('options: attorneys reached via multiple groups for one area are de-duplicated', () => {
  const service = seededService();
  service.routingGroups.create('martinson-beason', {
    key: 'probate-overflow', name: 'Probate Overflow',
    serviceArea: 'probate', providers: ['clay-martinson', 'raina-baugher'],
  });
  const options = getSchedulingOptions(service, 'martinson-beason');
  const ids = options.attorneysByPracticeArea['probate'].map((a) => a.id);
  assert.equal(ids.filter((id) => id === 'clay-martinson').length, 1);
  assert.ok(ids.includes('raina-baugher'));
});

test('options: consultation types come back active-only, in display order', () => {
  const options = getSchedulingOptions(seededService(), 'martinson-beason');
  assert.deepEqual(
    options.consultationTypes,
    [
      { id: 'initial-consultation', name: 'Initial Consultation' },
      { id: 'follow-up', name: 'Follow-up' },
      { id: 'existing-client', name: 'Existing Client' },
    ],
  );
});

test('options: an inactive consultation type is excluded', () => {
  const service = seededService();
  service.consultationTypes.update('martinson-beason', 'follow-up', { active: false });
  const options = getSchedulingOptions(service, 'martinson-beason');
  assert.deepEqual(
    options.consultationTypes.map((c) => c.id),
    ['initial-consultation', 'existing-client'],
  );
});

test('options: unknown firm throws unknown_organization', () => {
  assert.throws(
    () => getSchedulingOptions(seededService(), 'nobody'),
    (err) => err.code === 'unknown_organization' && err.status === 404,
  );
});

// ── HTTP endpoint ────────────────────────────────────────────────────────────

/** Start the app on an ephemeral port, run `fn(base)`, then close. */
async function withServer(opts, fn) {
  const app = createApp(opts);
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET scheduling-options returns 200 with areas and attorneys', async () => {
  await withServer({ configService: seededService() }, async (base) => {
    const res = await fetch(base + '/api/v1/firms/martinson-beason/scheduling-options');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.practiceAreas.length, 8);
    assert.deepEqual(body.attorneysByPracticeArea['military-law'], []);
    assert.ok(body.attorneysByPracticeArea['personal-injury'].length >= 1);
    assert.equal(body.consultationTypes.length, 3);
  });
});

test('GET scheduling-options for an unknown firm returns 404', async () => {
  await withServer({ configService: seededService() }, async (base) => {
    const res = await fetch(base + '/api/v1/firms/nobody/scheduling-options');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'unknown_organization');
  });
});

test('GET scheduling-options without a configured store returns 503', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + '/api/v1/firms/martinson-beason/scheduling-options');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'config_unavailable');
  });
});

test('GET scheduling-options carries CORS headers for allowlisted origins only', async () => {
  await withServer({ configService: seededService() }, async (base) => {
    const allowed = await fetch(base + '/api/v1/firms/martinson-beason/scheduling-options', {
      headers: { Origin: 'http://localhost:8080' },
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:8080');

    const denied = await fetch(base + '/api/v1/firms/martinson-beason/scheduling-options', {
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});
