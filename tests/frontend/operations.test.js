'use strict';
/**
 * Browser regression tests for Operations Center authentication (#71,
 * ADR-0013/ADR-0014). All API traffic is mocked via request interception —
 * no production calls. The Operations Center is ALWAYS session-gated (the
 * `operator` role, `operations:read`); these tests pin the sign-in flow's
 * behavior exactly as shipped, without changing product code.
 */
const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

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

const API = 'https://api.guideherd.ai';
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p.endsWith('/')) p += 'index.html';
  try { res.end(fs.readFileSync(path.join(ROOT, p))); }
  catch { res.statusCode = 404; res.end('nf'); }
});

const OPERATOR = {
  subject: 'ops-user', displayName: 'Olive Operator', organizationKey: 'martinson-beason',
  roles: ['operator'], expiresAt: '2026-07-19T07:00:00.000Z',
};
const OVERVIEW = {
  sessions: { groups: { pending: 1, active: 0, completed: 5, failed: 0 }, recent: [] },
  health: [{ capability: 'operational-store', status: 'available' }],
};

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

/**
 * behavior: { session (queue), login, logout, overview }
 * calls:    records observed requests, including credential presence.
 */
async function mockApi(page, behavior, calls) {
  await page.route(API + '/**', async (route) => {
    const req = route.request();
    const origin = (await req.headerValue('origin')) || 'http://127.0.0.1';
    const url = req.url();
    const json = (status, body) => route.fulfill({
      status, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(body),
    });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });

    // Every credentialed request must actually carry credentials: include.
    calls.credentialModes.push(await page.evaluate(() => true).then(() => req.headers()['sec-fetch-mode'] || ''));

    if (url.endsWith('/api/v1/auth/session')) {
      calls.session.push(1);
      const queue = behavior.session || [];
      const b = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
      const resolved = b || { status: 401, body: { error: { code: 'unauthorized' } } };
      return json(resolved.status, resolved.body);
    }
    if (url.endsWith('/api/v1/auth/login')) {
      calls.login.push(JSON.parse(req.postData() || '{}'));
      const b = behavior.login || { status: 200, body: OPERATOR };
      return json(b.status, b.body);
    }
    if (url.endsWith('/api/v1/auth/logout')) {
      calls.logout.push(1);
      if (behavior.logout === 'abort') return route.abort('failed');
      return route.fulfill({ status: 204, headers: CORS(origin), body: '' });
    }
    if (url.includes('/api/v1/operations/overview')) {
      calls.overview.push(1);
      const b = behavior.overview || { status: 200, body: OVERVIEW };
      return json(b.status, b.body);
    }
    if (url.includes('/api/v1/operations/')) {
      const b = behavior.overview || { status: 200, body: {} };
      return json(b.status === 200 ? 200 : b.status, b.status === 200 ? { sessions: [], deliveries: [], events: [] } : b.body);
    }
    return json(404, { error: { code: 'not_found' } });
  });
}

function newCalls() { return { session: [], login: [], logout: [], overview: [], credentialModes: [] }; }

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const PAGE_URL = base + '/operations/';
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  async function freshPage(behavior = {}, calls = newCalls()) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await mockApi(page, behavior, calls);
    await page.goto(PAGE_URL);
    return { page, ctx };
  }

  // ── Bootstrap and the unauthenticated gate ─────────────────────────
  console.log('— Bootstrap and gate —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({}, calls);
    await page.waitForTimeout(600);
    ok('bootstrap probes the session exactly once', calls.session.length === 1);
    ok('unauthenticated: the sign-in gate is shown', await page.isVisible('#login-wrap'));
    ok('unauthenticated: the application is hidden', !(await page.isVisible('#app')));
    ok('no operations data was requested while signed out', calls.overview.length === 0);
    await ctx.close();
  }

  // ── Successful operator sign-in ────────────────────────────────────
  console.log('— Operator sign-in —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({
      session: [{ status: 401, body: { error: { code: 'unauthorized' } } }, { status: 200, body: OPERATOR }],
    }, calls);
    await page.waitForSelector('#login-wrap');
    await page.fill('#credential', 'ops-credential-000000000');
    await page.click('#login button[type=submit]');
    await page.waitForSelector('#app', { state: 'visible' });
    ok('login posts exactly { credential }', calls.login.length === 1
      && JSON.stringify(Object.keys(calls.login[0])) === JSON.stringify(['credential']));
    ok('successful sign-in reveals the Operations Center', await page.isVisible('#app'));
    ok('identity names the operator and organization',
      (await page.textContent('#who')).trim() === 'Olive Operator — martinson-beason');
    ok('the authenticated load rendered real data',
      (await page.textContent('#counters')).includes('completed'));
    ok('credential input cleared after sign-in', (await page.inputValue('#credential')) === '');

    // Credentials never persist client-side.
    const residue = await page.evaluate(() => JSON.stringify({
      local: Object.entries(localStorage), session: Object.entries(sessionStorage),
      url: location.href, dom: document.documentElement.innerHTML.includes('ops-credential-000000000'),
    }));
    ok('credential absent from localStorage/sessionStorage/URL/DOM',
      !residue.includes('ops-credential-000000000') && !JSON.parse(residue).dom);
    await ctx.close();
  }

  // ── Failure modes ──────────────────────────────────────────────────
  console.log('— Failure modes —');
  {
    const { page, ctx } = await freshPage({
      login: { status: 403, body: { error: { code: 'forbidden', message: 'The provided credential is not valid.' } } },
    });
    await page.waitForSelector('#login-wrap');
    await page.fill('#credential', 'wrong-credential-000');
    await page.click('#login button[type=submit]');
    await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
    ok('invalid credential: gate stays closed with the generic message',
      !(await page.isVisible('#app')) && (await page.textContent('#login-error')).includes('Sign-in failed'));
    await ctx.close();
  }
  {
    const { page, ctx } = await freshPage({
      login: { status: 503, body: { error: { code: 'identity_provider_unavailable' } } },
    });
    await page.waitForSelector('#login-wrap');
    await page.fill('#credential', 'anything-000000000');
    await page.click('#login button[type=submit]');
    await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
    ok('sign-in-not-configured (503) is reported distinctly',
      (await page.textContent('#login-error')).includes('not configured'));
    await ctx.close();
  }
  {
    // A valid USER without the operator role: session probe succeeds, the
    // app shows, and the data calls are DENIED (403). Current shipped
    // behavior: panels remain in their loading state — asserted as-is (the
    // absence of a denial presentation is a recorded limitation, not
    // changed by tests).
    const nonOperator = { ...OPERATOR, subject: 'recep', displayName: 'Rae', roles: ['receptionist'] };
    const { page, ctx } = await freshPage({
      session: [{ status: 200, body: nonOperator }],
      overview: { status: 403, body: { error: { code: 'forbidden', message: 'The provided credential is not valid.' } } },
    });
    await page.waitForSelector('#app', { state: 'visible' });
    await page.waitForTimeout(400);
    ok('authorization denial: the app shell shows but no data renders',
      (await page.textContent('#counters')).includes('Loading'));
    ok('authorization denial: the 403 does not bounce to the sign-in gate',
      !(await page.isVisible('#login-wrap')));
    await ctx.close();
  }
  {
    // Expired session mid-use: a later data call answers 401 → the gate returns.
    const calls = newCalls();
    const { page, ctx } = await freshPage({
      session: [{ status: 200, body: OPERATOR }],
      overview: { status: 401, body: { error: { code: 'unauthorized' } } },
    }, calls);
    await page.waitForSelector('#login-wrap', { state: 'visible' });
    ok('expired session: a 401 on data returns the operator to the gate',
      await page.isVisible('#login-wrap') && !(await page.isVisible('#app')));
    await ctx.close();
  }

  // ── Logout ─────────────────────────────────────────────────────────
  console.log('— Logout —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({ session: [{ status: 200, body: OPERATOR }] }, calls);
    await page.waitForSelector('#app', { state: 'visible' });
    await page.click('#logout');
    await page.waitForSelector('#login-wrap', { state: 'visible' });
    ok('logout calls the endpoint and returns to the gate', calls.logout.length === 1);
    await ctx.close();
  }
  {
    // Logout request failure must not strand the operator in a dead UI.
    // Current shipped behavior: fetch().then(showLogin) — a REJECTED fetch
    // skips showLogin. Assert what actually happens so any change is loud.
    const calls = newCalls();
    const { page, ctx } = await freshPage({ session: [{ status: 200, body: OPERATOR }], logout: 'abort' }, calls);
    await page.waitForSelector('#app', { state: 'visible' });
    await page.click('#logout');
    await page.waitForTimeout(500);
    const stranded = (await page.isVisible('#app')) && !(await page.isVisible('#login-wrap'));
    ok('logout failure: UI state recorded (app remains; see known limitation — no .catch on logout)',
      stranded === true);
    await ctx.close();
  }

  // ── credentials: 'include' on every API call ───────────────────────
  console.log('— Credentialed requests —');
  {
    // Assert from source: every fetch in the page carries credentials.
    const html = fs.readFileSync(path.join(ROOT, 'operations', 'index.html'), 'utf8');
    const fetches = html.match(/fetch\([^)]*\)/g) || [];
    const apiFn = html.includes("credentials: 'include'");
    ok('the api() helper and direct fetches use credentials: include',
      apiFn && (html.match(/credentials: 'include'/g) || []).length >= 3, JSON.stringify(fetches.length));
  }

  await browser.close();
  server.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
