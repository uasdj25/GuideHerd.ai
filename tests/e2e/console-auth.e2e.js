'use strict';
/**
 * Single-process end-to-end verification of authenticated receptionist access.
 *
 * Runs the REAL server (createApp) in-process with GUIDEHERD_CONSOLE_AUTH=required,
 * a local non-production dev user, and a real browser driving the real console.
 * No mocks, no route interception, no production endpoint.
 *
 * Covers: the gate, login, session restoration across reload, handoff creation
 * as an authenticated receptionist, mid-workflow expiry, logout, and the
 * anonymous-floor rollback.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.join(__dirname, '..', 'frontend', 'node_modules', 'playwright-core'));

const ROOT = path.resolve(__dirname, '..', '..');
const { createApp } = require(path.join(ROOT, 'server/handoff/app.js'));
const { openDatabase } = require(path.join(ROOT, 'server/config/db.js'));
const { migrate } = require(path.join(ROOT, 'server/config/migrate.js'));
const { createConfigService } = require(path.join(ROOT, 'server/config/service.js'));
const seed = require(path.join(ROOT, 'server/config/seed.js'));

// Seed a throwaway configuration store from the repo's example firm document,
// so the console renders real practice areas, attorneys, and consultation
// types rather than an empty store.
const SEED_DB = path.join(require('node:os').tmpdir(), `gh-e2e-${process.pid}.db`);
const SEED_DOC = path.join(ROOT, 'server/config/data/martinson-beason.example.json');
function freshConfigService() {
  const db = openDatabase({ path: SEED_DB });
  migrate(db);
  const service = createConfigService({ db });
  service.importOrganization(seed.loadSeedDocument(SEED_DOC));
  return service;
}

// A LOCAL, NON-PRODUCTION credential. Never provisioned anywhere real.
const LOCAL_KEY = 'local-e2e-key-000000000000';
const FIRM = 'martinson-beason';
const DEV_USERS = JSON.stringify([{
  key: LOCAL_KEY, subject: 'e2e-receptionist', displayName: 'E2E Receptionist',
  organizationKey: FIRM, roles: ['receptionist'],
}]);

/** Chromium lookup, same contract as the frontend suite. */
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const dir of roots) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        for (const rel of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
          const p = path.join(dir, entry, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* try next root */ }
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.');
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ FAIL: ' + n + (x ? ' — ' + x : ''))); };

// Static host for the console page (same-origin with the API so the Secure/
// SameSite=Strict cookie behaves as it does in production).
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

async function startStack({ consoleAuth, ttlSeconds }) {
  try { fs.rmSync(SEED_DB, { force: true }); } catch {}
  const app = createApp({
    consoleAuth,
    devUsersJson: DEV_USERS,
    userSessionTtlSeconds: ttlSeconds,
    configService: freshConfigService(),
  });
  const server = http.createServer((req, res) => {
    // Serve the console pages; delegate /api/* to the real app handler.
    if (req.url.startsWith('/api/')) return app.handler(req, res);
    let p = req.url.split('?')[0];
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, r));
  return { app, server, port: server.address().port };
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  // ────────── GUIDEHERD_CONSOLE_AUTH=required ──────────
  console.log('— required: real server, real browser, real session —');
  {
    const { server, port } = await startStack({ consoleAuth: 'required' });
    const base = `http://127.0.0.1:${port}`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // The API must fail closed for an unauthenticated caller.
    const anonOptions = await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`);
    ok('API: scheduling-options is 401 without a session', anonOptions.status === 401, `got ${anonOptions.status}`);
    const anonCreate = await fetch(`${base}/api/v1/handoffs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // The REAL payload shape the console sends. Validation runs before
      // authorization, so a malformed body would return 400 and prove nothing
      // about whether the route fails closed.
      body: JSON.stringify({
        firmId: FIRM,
        caller: { fullName: 'Anon Probe', email: 'anon.probe@example.com' },
        scheduling: { practiceAreaId: 'personal-injury', consultationTypeId: 'initial-consultation' },
        handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
      }),
    });
    ok('API: create handoff is 401 without a session', anonCreate.status === 401, `got ${anonCreate.status}`);

    await page.goto(`${base}/receptionist/?apiBase=${base}`);
    await page.waitForSelector('#login-wrap:not([hidden])', { timeout: 8000 });
    ok('console presents the sign-in gate', await page.isVisible('#login-wrap'));
    ok('console itself is not reachable', !(await page.isVisible('#main')));

    // Wrong credential first — must fail closed.
    await page.fill('#credential', 'not-the-right-credential');
    await page.click('#login-btn');
    await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0, { timeout: 8000 });
    ok('wrong credential is rejected', !(await page.isVisible('#main')));
    ok('wrong credential message is calm',
      (await page.textContent('#login-error')).includes('not accepted'),
      await page.textContent('#login-error'));

    // Real login.
    await page.fill('#credential', LOCAL_KEY);
    await page.click('#login-btn');
    await page.waitForSelector('#caller-name', { timeout: 8000 });
    ok('login reveals the console', await page.isVisible('#main'));
    ok('identity chip names the user and organization',
      (await page.textContent('#who')).trim() === `E2E Receptionist — ${FIRM}`,
      await page.textContent('#who'));

    // The real cookie must be HttpOnly and host-only, and unreadable by JS.
    const cookies = await ctx.cookies();
    const sess = cookies.find((c) => c.name === 'gh_session');
    ok('session cookie issued', !!sess);
    ok('session cookie is HttpOnly', sess && sess.httpOnly === true);
    ok('session cookie is SameSite=Strict', sess && sess.sameSite === 'Strict');
    ok('page JavaScript cannot read the session cookie',
      (await page.evaluate(() => document.cookie)).indexOf('gh_session') === -1);
    ok('credential is not in browser storage',
      !(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).includes(LOCAL_KEY));

    // Session restoration across a full page reload.
    await page.reload();
    await page.waitForSelector('#caller-name', { timeout: 8000 });
    ok('session survives a page reload', await page.isVisible('#main'));
    ok('identity restored after reload', (await page.textContent('#who')).includes('E2E Receptionist'));

    // A real authenticated handoff, end to end through the real server.
    await page.fill('#caller-name', 'E2E Caller');
    await page.fill('#caller-email', 'e2e.caller@example.com');
    await page.waitForSelector('#practice-area:not([disabled])');
    await page.selectOption('#practice-area', 'personal-injury');
    await page.click('label[for="ct-initial-consultation"]');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 10000 });
    ok('authenticated receptionist can create a handoff', await page.isVisible('#ready-panel'));

    // Sign out — server-side invalidation, then the gate returns.
    await page.click('#logout');
    await page.waitForSelector('#login-wrap:not([hidden])', { timeout: 8000 });
    ok('sign-out returns to the gate', await page.isVisible('#login-wrap'));
    ok('sign-out hides the console', !(await page.isVisible('#main')));
    const after = (await ctx.cookies()).find((c) => c.name === 'gh_session');
    ok('session cookie cleared on sign-out', !after || !after.value);

    await ctx.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  // ────────── mid-workflow expiry, driven by a real short TTL ──────────
  console.log('— required: real session expiry mid-workflow —');
  {
    const { server, port } = await startStack({ consoleAuth: 'required', ttlSeconds: 2 });
    const base = `http://127.0.0.1:${port}`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/receptionist/?apiBase=${base}`);
    await page.waitForSelector('#login-wrap:not([hidden])', { timeout: 8000 });
    await page.fill('#credential', LOCAL_KEY);
    await page.click('#login-btn');
    await page.waitForSelector('#caller-name', { timeout: 8000 });

    // Fill the form, then let the real 2s absolute TTL lapse before submitting.
    await page.fill('#caller-name', 'Expiry Caller');
    await page.fill('#caller-email', 'expiry@example.com');
    await page.waitForSelector('#practice-area:not([disabled])');
    await page.selectOption('#practice-area', 'personal-injury');
    await page.click('label[for="ct-initial-consultation"]');
    await page.waitForTimeout(2500); // absolute expiry: activity does not extend it
    await page.click('#prepare-btn');

    await page.waitForSelector('#login-wrap:not([hidden])', { timeout: 10000 });
    ok('expired session mid-workflow returns to the gate', await page.isVisible('#login-wrap'));
    ok('expiry explains itself',
      (await page.textContent('#login-error')).includes('session ended'),
      await page.textContent('#login-error'));
    ok('caller details preserved for resumption',
      (await page.inputValue('#caller-name')) === 'Expiry Caller'
      && (await page.inputValue('#caller-email')) === 'expiry@example.com');

    // And signing back in resumes the work rather than restarting it.
    await page.fill('#credential', LOCAL_KEY);
    await page.click('#login-btn');
    await page.waitForSelector('#caller-name', { timeout: 8000 });
    ok('re-authentication resumes with details intact',
      (await page.inputValue('#caller-name')) === 'Expiry Caller');

    await ctx.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  // ────────── anonymous-floor rollback ──────────
  console.log('— anonymous: rollback restores today\'s posture —');
  {
    const { server, port } = await startStack({ consoleAuth: 'anonymous' });
    const base = `http://127.0.0.1:${port}`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const anonOptions = await fetch(`${base}/api/v1/firms/${FIRM}/scheduling-options`);
    ok('API: scheduling-options is 200 anonymously', anonOptions.status === 200, `got ${anonOptions.status}`);

    await page.goto(`${base}/receptionist/?apiBase=${base}`);
    await page.waitForSelector('#caller-name', { timeout: 8000 });
    ok('console operates without signing in', await page.isVisible('#main'));
    ok('sign-in gate stays hidden', !(await page.isVisible('#login-wrap')));
    ok('no identity chip', !(await page.isVisible('#identity')));

    await page.fill('#caller-name', 'Anon Caller');
    await page.fill('#caller-email', 'anon@example.com');
    await page.waitForSelector('#practice-area:not([disabled])');
    await page.selectOption('#practice-area', 'personal-injury');
    await page.click('label[for="ct-initial-consultation"]');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 10000 });
    ok('anonymous handoff still creatable — rollback is complete', await page.isVisible('#ready-panel'));

    await ctx.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  await browser.close();
  console.log(`\nE2E RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E CRASH:', e); process.exit(1); });
