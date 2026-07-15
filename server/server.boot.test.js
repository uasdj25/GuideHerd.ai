'use strict';

/**
 * Boot-level tests for server.js itself (not just createApp()). These spawn
 * the real entrypoint as a subprocess — the way Railway/`npm start` actually
 * run it — because the seed-on-boot bootstrap calls process.exit() on
 * failure, which cannot be exercised safely in-process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, 'server.js');
const EXAMPLE_FILE = path.join(__dirname, 'config', 'data', 'martinson-beason.example.json');

/** Find a free TCP port for a child server process to bind. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Wait for a stdout line of JSON matching `predicate`, or reject on exit/timeout. */
function waitForLog(child, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for a matching log line'));
    }, timeoutMs);
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
          return;
        }
      }
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`process exited before a matching log line (code ${code})`));
    }
    function cleanup() {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
    }
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

function spawnServer(port, extraEnv = {}) {
  return spawn(process.execPath, ['--experimental-sqlite', SERVER_JS], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), ...extraEnv },
  });
}

test('GUIDEHERD_SEED_FILE imports the document before serving, and the API reflects it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-server-boot-'));
  const dbPath = path.join(dir, 'config.db');
  const port = await getFreePort();
  const child = spawnServer(port, { GUIDEHERD_CONFIG_DB: dbPath, GUIDEHERD_SEED_FILE: EXAMPLE_FILE });

  try {
    const listening = await waitForLog(child, (l) => typeof l.message === 'string' && l.message.includes('listening on'));
    assert.ok(listening.seeded, 'startup log reports a seed result');
    assert.equal(listening.seeded.organization, 'martinson-beason');
    assert.ok(listening.seeded.counts.providers > 0);

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/firms/martinson-beason/scheduling-options`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.practiceAreas.length > 0);
  } finally {
    child.kill();
  }
});

test('without GUIDEHERD_SEED_FILE, the server boots normally with no seed applied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-server-boot-'));
  const dbPath = path.join(dir, 'config.db');
  const port = await getFreePort();
  const child = spawnServer(port, { GUIDEHERD_CONFIG_DB: dbPath });

  try {
    const listening = await waitForLog(child, (l) => typeof l.message === 'string' && l.message.includes('listening on'));
    assert.equal(listening.seedFile, null);
    assert.equal(listening.seeded, null);

    // An unseeded store has no organizations: the endpoint 404s rather than
    // silently serving empty data.
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/firms/martinson-beason/scheduling-options`);
    assert.equal(res.status, 404);
  } finally {
    child.kill();
  }
});

test('an invalid seed file exits non-zero and never binds the port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-server-boot-'));
  const dbPath = path.join(dir, 'config.db');
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{ not json');
  const port = await getFreePort();
  const child = spawnServer(port, { GUIDEHERD_CONFIG_DB: dbPath, GUIDEHERD_SEED_FILE: badFile });

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 1);

  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
});
