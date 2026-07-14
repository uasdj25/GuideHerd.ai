'use strict';
const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Repo root, resolved relative to this file so the suite runs from anywhere.
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Locate a Chromium executable. Preference order:
 *   1. CHROMIUM_PATH env var
 *   2. Playwright-managed browsers under PLAYWRIGHT_BROWSERS_PATH
 * The suite uses playwright-core, which does not download browsers itself.
 */
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

const MOCK = {
  sessionId: 'mock-session-1',
  handoffToken: 'gh_handoff_MOCKMOCKMOCKMOCKMOCKMOCKMOCK',
  consoleToken: 'gh_console_MOCKMOCKMOCKMOCKMOCKMOCKMOCK',
};

// Scheduling options served by the mock configuration endpoint. military-law
// is deliberately unrouted so the "No Attorneys Configured" path is covered.
const MOCK_OPTIONS = {
  practiceAreas: [
    { id: 'personal-injury', name: 'Personal Injury' },
    { id: 'family-law', name: 'Family Law & Divorce' },
    { id: 'military-law', name: 'Military Law' },
  ],
  attorneysByPracticeArea: {
    'personal-injury': [
      { id: 'clay-martinson', name: 'Clay Martinson' },
      { id: 'morris-lilienthal', name: 'Morris Lilienthal' },
    ],
    'family-law': [{ id: 'raina-baugher', name: 'Raina Baugher' }],
    'military-law': [],
  },
  consultationTypes: [
    { id: 'initial-consultation', name: 'Initial Consultation' },
    { id: 'follow-up', name: 'Follow-up' },
    { id: 'existing-client', name: 'Existing Client' },
  ],
};

function createBody(expiresInMs) {
  const now = Date.now();
  return {
    ...MOCK,
    status: 'awaiting-transfer',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInMs).toISOString(),
    expiresInSeconds: Math.round(expiresInMs / 1000),
  };
}

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

/**
 * Install an API mock on a page. `behavior` controls each endpoint:
 *   create: fn(route, request) or object {status, body} ...
 *   status: array of responses consumed in order (last repeats)
 *   del:    {status, body}
 * Records observed requests in `calls`.
 */
async function mockApi(page, behavior, calls) {
  await page.route(API + '/**', async (route) => {
    const req = route.request();
    const origin = (await req.headerValue('origin')) || 'http://127.0.0.1';
    const method = req.method();
    const url = req.url();

    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS(origin) });
    }

    if (method === 'GET' && /\/api\/v1\/firms\/[^/]+\/scheduling-options$/.test(url)) {
      calls.options.push(url);
      const queue = behavior.options;
      const b = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
      if (b === 'abort') return route.abort('failed');
      const resolved = b || { status: 200, body: MOCK_OPTIONS };
      return route.fulfill({
        status: resolved.status, headers: { 'content-type': 'application/json', ...CORS(origin) },
        body: JSON.stringify(resolved.body),
      });
    }

    if (method === 'POST' && url.endsWith('/api/v1/handoffs')) {
      calls.create.push(JSON.parse(req.postData() || '{}'));
      const b = typeof behavior.create === 'function' ? behavior.create() : behavior.create;
      if (b === 'abort') return route.abort('failed');
      if (b === 'stall') return; // never respond -> client timeout
      return route.fulfill({
        status: b.status, headers: { 'content-type': 'application/json', ...CORS(origin) },
        body: JSON.stringify(b.body),
      });
    }

    if (method === 'GET' && /\/api\/v1\/handoffs\/[^/]+$/.test(url)) {
      calls.status.push({ auth: await req.headerValue('authorization'), url });
      const queue = behavior.status || [];
      const b = queue.length > 1 ? queue.shift() : queue[0];
      if (!b || b === 'abort') return route.abort('failed');
      return route.fulfill({
        status: b.status, headers: { 'content-type': 'application/json', ...CORS(origin) },
        body: JSON.stringify(b.body),
      });
    }

    if (method === 'DELETE' && /\/api\/v1\/handoffs\/[^/]+$/.test(url)) {
      calls.del.push({ auth: await req.headerValue('authorization'), url });
      const b = behavior.del;
      if (!b || b === 'abort') return route.abort('failed');
      return route.fulfill({
        status: b.status, headers: { 'content-type': 'application/json', ...CORS(origin) },
        body: JSON.stringify(b.body),
      });
    }

    return route.fulfill({ status: 404, headers: CORS(origin), body: '{}' });
  });
}

function newCalls() { return { create: [], status: [], del: [], options: [] }; }

/**
 * Fill the required fields. Practice area drives the attorney list, so it is
 * selected first; pass `opts.attorney = null` to leave the (optional)
 * attorney as "No preference". A consultation type is required — the default
 * is initial-consultation; override with `opts.consultationType`.
 */
async function fillRequired(page, name = 'David Jones', email = 'david.jones@example.com', opts = {}) {
  await page.fill('#caller-name', name);
  await page.fill('#caller-email', email);
  await page.waitForSelector('#practice-area:not([disabled])');
  await page.selectOption('#practice-area', opts.practiceArea || 'personal-injury');
  if (opts.attorney !== null) {
    await page.selectOption('#attorney', opts.attorney || 'clay-martinson');
  }
  await page.click('label[for="ct-' + (opts.consultationType || 'initial-consultation') + '"]');
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const PAGE_URL = base + '/receptionist/';
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  async function freshPage(behavior, calls) {
    const page = await browser.newPage();
    await mockApi(page, behavior, calls);
    await page.goto(PAGE_URL);
    return page;
  }

  // ── 1-4: create + payload mapping ─────────────────────────────────
  console.log('— Create + payload mapping —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: () => ({ status: 201, body: createBody(600000) }),
      status: [{ status: 200, body: { sessionId: MOCK.sessionId, status: 'awaiting-transfer' } }],
    }, calls);

    ok('title is GuideHerd Console — Reception Mode', (await page.title()) === 'GuideHerd Console — Reception Mode');
    ok('heading + mode label', (await page.textContent('h1')).trim() === 'GuideHerd Console'
      && (await page.textContent('.mode-label')).trim() === 'Reception Mode');

    await fillRequired(page);
    await page.fill('#phone', '+1 404 423 2676');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 5000 });

    ok('reaches Ready to transfer from real 201', (await page.textContent('#status-text')).trim() === 'Ready to transfer');
    ok('exactly one create call', calls.create.length === 1);
    const p = calls.create[0];
    ok('payload: full mapping exact', JSON.stringify(p) === JSON.stringify({
      firmId: 'martinson-beason',
      caller: { fullName: 'David Jones', email: 'david.jones@example.com', phone: '+1 404 423 2676' },
      scheduling: {
        practiceAreaId: 'personal-injury',
        consultationTypeId: 'initial-consultation',
        attorneyId: 'clay-martinson',
      },
      handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
    }), JSON.stringify(p));
    {
      const cd = (await page.textContent('#countdown')).trim();
      ok('countdown derived from server expiresAt (10:00/9:5x)', /^(10:00|9:5\d)$/.test(cd), 'actual=' + JSON.stringify(cd));
    }
    ok('focus on Ready heading', await page.evaluate(() => document.activeElement.id === 'ready-title'));

    // 17/18: token hygiene
    const content = await page.content();
    ok('no tokens or session id in DOM', !content.includes(MOCK.handoffToken) && !content.includes(MOCK.consoleToken) && !content.includes(MOCK.sessionId));
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    ok('nothing in local/sessionStorage', storage === '{"l":{},"s":{}}', storage);

    // 7: polling begins with bearer console token
    await page.waitForTimeout(3000);
    ok('polling began after create', calls.status.length >= 1);
    ok('poll uses Bearer console token', calls.status[0].auth === 'Bearer ' + MOCK.consoleToken);
    ok('poll URL targets the session', calls.status[0].url.endsWith('/api/v1/handoffs/' + MOCK.sessionId));
    await page.close();
  }

  {
    const calls = newCalls();
    const page = await freshPage({ create: { status: 201, body: createBody(600000) }, status: [{ status: 200, body: { status: 'awaiting-transfer' } }] }, calls);
    await fillRequired(page, 'Blank Optional', 'david.jones@example.com', { attorney: null });
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    const p = calls.create[0];
    ok('blank phone omitted', !('phone' in p.caller));
    ok('no-preference attorney omitted', !('attorneyId' in p.scheduling));
    ok('practice area always sent', p.scheduling.practiceAreaId === 'personal-injury');
    ok('retired existingClient never sent', !('existingClient' in p.scheduling));
    ok('summary shows No preference for attorney', (await page.textContent('#sum-attorney')).trim() === 'No preference');
    await page.close();
  }

  {
    // The selected consultation type flows into the payload and summary.
    const calls = newCalls();
    const page = await freshPage({ create: { status: 201, body: createBody(600000) }, status: [{ status: 200, body: { status: 'awaiting-transfer' } }] }, calls);
    await fillRequired(page, 'Follow Up Caller', 'follow.up@example.com', { consultationType: 'follow-up' });
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    ok('selected consultation type sent', calls.create[0].scheduling.consultationTypeId === 'follow-up');
    ok('summary shows consultation type', (await page.textContent('#sum-consultation')).trim() === 'Follow-up');
    await page.close();
  }

  // ── 5: duplicate submission prevention ────────────────────────────
  console.log('— Duplicate submission prevention —');
  {
    const calls = newCalls();
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = await browser.newPage();
    await page.route(API + '/**', async (route) => {
      const req = route.request();
      const origin = (await req.headerValue('origin')) || '*';
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });
      if (req.method() === 'GET' && req.url().includes('/scheduling-options')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(MOCK_OPTIONS) });
      }
      if (req.method() === 'POST' && req.url().endsWith('/handoffs')) {
        calls.create.push(1);
        await gate; // hold the first create open
        return route.fulfill({ status: 201, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(createBody(600000)) });
      }
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify({ status: 'awaiting-transfer' }) });
    });
    await page.goto(PAGE_URL);
    await fillRequired(page);
    await page.click('#prepare-btn');
    // Try to submit again while the first request is in flight (Enter on form)
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.getElementById('caller-form').requestSubmit
      ? document.getElementById('caller-form').requestSubmit() : null).catch(() => {});
    release();
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 5000 });
    ok('only one create request despite repeated submits', calls.create.length === 1, 'got ' + calls.create.length);
    await page.close();
  }

  // ── 8: connected via polling ──────────────────────────────────────
  console.log('— Connected state —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(600000) },
      status: [
        { status: 200, body: { sessionId: MOCK.sessionId, status: 'awaiting-transfer' } },
        { status: 200, body: { sessionId: MOCK.sessionId, status: 'connected' } },
      ],
    }, calls);
    await fillRequired(page, 'Connie Caller');
    await page.click('#prepare-btn');
    await page.waitForSelector('#connected-panel:not([hidden])', { timeout: 12000 });
    ok('status = Caller connected', (await page.textContent('#status-text')).trim() === 'Caller connected');
    ok('speaking-with copy uses caller name', (await page.textContent('#connected-name')).trim() === 'GuideHerd is speaking with Connie Caller.');
    ok('no appointment claim', !(await page.textContent('#connected-panel')).toLowerCase().includes('appointment'));
    ok('focus moved to Connected heading', await page.evaluate(() => document.activeElement.id === 'connected-title'));
    const before = calls.status.length;
    await page.waitForTimeout(3200);
    ok('polling continues after connected (awaiting outcome)', calls.status.length > before);
    // 19: reset
    await page.click('#next-caller-btn');
    ok('Ready for Next Caller resets to form', !(await page.isHidden('#caller-form')));
    ok('form cleared + focus on caller name', (await page.inputValue('#caller-name')) === ''
      && await page.evaluate(() => document.activeElement.id === 'caller-name'));
    await page.close();
  }

  // ── 9: cancellation success ───────────────────────────────────────
  console.log('— Cancellation —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(600000) },
      status: [{ status: 200, body: { status: 'awaiting-transfer' } }],
      del: { status: 200, body: { sessionId: MOCK.sessionId, status: 'cancelled' } },
    }, calls);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    await page.click('#cancel-btn');
    ok('confirmation appears with focus on Yes', !(await page.isHidden('#cancel-confirm'))
      && await page.evaluate(() => document.activeElement.id === 'cancel-yes'));
    await page.click('#cancel-keep');
    ok('Keep session dismisses confirm', await page.isHidden('#cancel-confirm'));
    await page.click('#cancel-btn');
    await page.click('#cancel-yes');
    await page.waitForSelector('#ended-panel:not([hidden])', { timeout: 5000 });
    ok('cancelled state after API confirms', (await page.textContent('#ended-title')).trim() === 'Session cancelled');
    ok('DELETE used bearer console token', calls.del[0].auth === 'Bearer ' + MOCK.consoleToken);
    await page.close();
  }

  // ── 10: cancel conflict -> status refresh -> connected ───────────
  {
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(600000) },
      status: [{ status: 200, body: { sessionId: MOCK.sessionId, status: 'connected' } }],
      del: { status: 409, body: { error: { code: 'cannot_cancel', message: 'x' } } },
    }, calls);
    await fillRequired(page, 'Race Winner');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    await page.click('#cancel-btn');
    await page.click('#cancel-yes');
    await page.waitForSelector('#connected-panel:not([hidden])', { timeout: 5000 });
    ok('409 cancel -> refreshed status -> Caller connected', (await page.textContent('#status-text')).trim() === 'Caller connected');
    await page.close();
  }

  // ── 11: expiration from server expiresAt ──────────────────────────
  console.log('— Expiration —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(2000) }, // expires in 2s
      status: [{ status: 200, body: { status: 'awaiting-transfer' } }],
    }, calls);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#ended-panel:not([hidden])', { timeout: 8000 });
    ok('expires when expiresAt passes', (await page.textContent('#ended-title')).trim() === 'Session expired');
    ok('expiry guidance shown', (await page.textContent('#ended-sub')).includes('Prepare a new session'));
    await page.close();
  }

  // ── 13: create network failure ────────────────────────────────────
  console.log('— Error handling —');
  {
    const calls = newCalls();
    const page = await freshPage({ create: 'abort' }, calls);
    await fillRequired(page, 'Retry Person');
    await page.fill('#phone', '+1 555 0100');
    await page.click('#prepare-btn');
    await page.waitForSelector('#error-panel:not([hidden])', { timeout: 5000 });
    ok('create failure shows calm message', (await page.textContent('#error-sub')).includes("We couldn't prepare the scheduling assistant"));
    const errText = await page.textContent('#error-panel');
    ok('no technical detail in error', !/\b(HTTP|4\d\d|5\d\d|fetch|json|stack|api\.guideherd)\b/i.test(errText));
    ok('focus moved to error heading', await page.evaluate(() => document.activeElement.id === 'error-title'));
    await page.click('#error-form-btn');
    ok('Return to Form preserves entered values', (await page.inputValue('#caller-name')) === 'Retry Person'
      && (await page.inputValue('#phone')) === '+1 555 0100');
    await page.close();
  }

  // ── 16: malformed create response ─────────────────────────────────
  {
    const calls = newCalls();
    const page = await freshPage({ create: { status: 201, body: { nothing: 'useful' } } }, calls);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#error-panel:not([hidden])', { timeout: 5000 });
    ok('malformed 201 body lands in error state', true);
    await page.close();
  }

  // Try Again after create failure re-submits
  {
    const calls = newCalls();
    let fail = true;
    const page = await browser.newPage();
    await page.route(API + '/**', async (route) => {
      const req = route.request();
      const origin = (await req.headerValue('origin')) || '*';
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });
      if (req.method() === 'GET' && req.url().includes('/scheduling-options')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(MOCK_OPTIONS) });
      }
      if (req.method() === 'POST' && req.url().endsWith('/handoffs')) {
        calls.create.push(1);
        if (fail) { fail = false; return route.abort('failed'); }
        return route.fulfill({ status: 201, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(createBody(600000)) });
      }
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify({ status: 'awaiting-transfer' }) });
    });
    await page.goto(PAGE_URL);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#error-panel:not([hidden])');
    await page.click('#error-retry-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 5000 });
    ok('Try Again re-submits create and succeeds', calls.create.length === 2);
    await page.close();
  }

  // ── 14/15: polling transient failure + repeated failure ──────────
  console.log('— Polling resilience —');
  {
    // one failure then recovery: stays in ready state
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(600000) },
      status: ['abort', { status: 200, body: { status: 'awaiting-transfer' } }],
    }, calls);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    await page.waitForTimeout(6500); // two poll cycles: fail then succeed
    ok('one transient poll failure does not disturb the session', !(await page.isHidden('#ready-panel')));
    await page.close();
  }
  {
    // three consecutive failures -> status uncertain
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(600000) },
      status: ['abort'],
    }, calls);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    await page.waitForSelector('#error-panel:not([hidden])', { timeout: 15000 });
    ok('repeated poll failures -> status-uncertain message',
      (await page.textContent('#error-sub')).includes('temporarily lost contact'));
    ok('does not falsely claim cancelled/expired',
      !(await page.textContent('#error-panel')).match(/cancelled|expired/i));
    await page.close();
  }

  // ── 12: create timeout (10s AbortController) ──────────────────────
  console.log('— Create timeout (10s) —');
  {
    const calls = newCalls();
    const page = await freshPage({ create: 'stall' }, calls);
    await fillRequired(page);
    await page.click('#prepare-btn');
    await page.waitForSelector('#error-panel:not([hidden])', { timeout: 14000 });
    ok('stalled create times out into error state', true);
    await page.close();
  }

  // ── 21/22: layout + vendor scan ───────────────────────────────────
  console.log('— Layout + content hygiene —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: { status: 201, body: createBody(600000) },
      status: [{ status: 200, body: { status: 'awaiting-transfer' } }],
    }, calls);
    const html = await page.content();
    ok('no vendor/infra names visible', !/\b(ElevenLabs|Cal\.com|OpenClaw|Railway|Cloudflare|Lex)\b/i.test(html));
    await page.setViewportSize({ width: 1440, height: 900 });
    ok('desktop: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.setViewportSize({ width: 375, height: 720 });
    ok('mobile: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.close();
  }

  // ── Slice 3: required email ───────────────────────────────────────
  console.log('— Required email —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: () => ({ status: 201, body: createBody(600000) }),
      status: [{ status: 200, body: { status: 'awaiting-transfer' } }],
    }, calls);
    await page.fill('#caller-name', 'No Email');
    await page.waitForSelector('#practice-area:not([disabled])');
    await page.selectOption('#practice-area', 'personal-injury');
    await page.click('label[for="ct-initial-consultation"]');
    ok('name+practice+type without email keeps button disabled', await page.isDisabled('#prepare-btn'));
    await page.fill('#caller-email', 'not-an-email');
    ok('malformed email keeps button disabled', await page.isDisabled('#prepare-btn'));
    await page.fill('#caller-email', 'valid@example.com');
    ok('valid email enables button', !(await page.isDisabled('#prepare-btn')));
    // accessible validation attributes
    const described = await page.getAttribute('#caller-email', 'aria-describedby');
    ok('email field wired to its error message', described === 'caller-email-error');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    ok('email shown in prepared summary', (await page.textContent('#sum-email')).trim() === 'valid@example.com');
    ok('payload carries trimmed email', calls.create[0].caller.email === 'valid@example.com');
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    ok('email not persisted to browser storage', storage === '{"l":{},"s":{}}');
    await page.close();
  }
  {
    // create failure preserves the email value
    const calls = newCalls();
    const page = await freshPage({ create: 'abort' }, calls);
    await fillRequired(page, 'Keep Values', 'keep.me@example.com');
    await page.click('#prepare-btn');
    await page.waitForSelector('#error-panel:not([hidden])');
    await page.click('#error-form-btn');
    ok('email preserved after create failure', (await page.inputValue('#caller-email')) === 'keep.me@example.com');
    await page.close();
  }

  // ── Slice 3: truthful outcome states ─────────────────────────────
  console.log('— Outcome states —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: () => ({ status: 201, body: createBody(600000) }),
      status: [
        { status: 200, body: { sessionId: MOCK.sessionId, status: 'connected' } },
        { status: 200, body: {
          sessionId: MOCK.sessionId, status: 'booked',
          createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
          appointment: { startsAt: '2026-07-20T15:00:00-05:00', timezone: 'America/Chicago', attorneyId: 'clay-martinson' },
        } },
      ],
    }, calls);
    await fillRequired(page, 'Booked Caller');
    await page.click('#prepare-btn');
    await page.waitForSelector('#connected-panel:not([hidden])', { timeout: 10000 });
    ok('connected first (never claims booked early)', true);
    await page.waitForSelector('#booked-panel:not([hidden])', { timeout: 10000 });
    ok('booked panel appears after API reports booked', true);
    ok('status = Appointment booked', (await page.textContent('#status-text')).trim() === 'Appointment booked');
    ok('booked date shown', (await page.textContent('#booked-date')).includes('July 20, 2026'));
    ok('booked time shown', /3:00\s?PM/i.test(await page.textContent('#booked-time')));
    ok('booked timezone shown', (await page.textContent('#booked-tz')).trim() === 'America/Chicago');
    ok('booked attorney shown', (await page.textContent('#booked-attorney')).trim() === 'Clay Martinson');
    ok('focus moved to booked heading', await page.evaluate(() => document.activeElement.id === 'booked-title'));
    ok('no email-delivery claim in booked panel', !/email|summary sent|delivered/i.test(await page.textContent('#booked-panel')));
    const before = calls.status.length;
    await page.waitForTimeout(3200);
    ok('polling stops after booked', calls.status.length === before);
    await page.click('#booked-next-btn');
    ok('booked resets to fresh form with focus on name', (await page.inputValue('#caller-name')) === ''
      && await page.evaluate(() => document.activeElement.id === 'caller-name'));
    await page.close();
  }
  {
    // failed and escalated
    for (const [status, title] of [['failed', 'Scheduling could not be completed'], ['escalated', 'Human assistance required']]) {
      const calls = newCalls();
      const page = await freshPage({
        create: () => ({ status: 201, body: createBody(600000) }),
        status: [
          { status: 200, body: { status: 'connected' } },
          { status: 200, body: { status } },
        ],
      }, calls);
      await fillRequired(page);
      await page.click('#prepare-btn');
      await page.waitForSelector('#ended-panel:not([hidden])', { timeout: 12000 });
      ok(`${status} -> "${title}"`, (await page.textContent('#ended-title')).trim() === title);
      await page.close();
    }
  }

  // ── Config-driven scheduling options ──────────────────────────────
  console.log('— Config-driven scheduling options —');
  {
    const calls = newCalls();
    const page = await freshPage({
      create: () => ({ status: 201, body: createBody(600000) }),
      status: [{ status: 200, body: { status: 'awaiting-transfer' } }],
    }, calls);
    await page.waitForSelector('#practice-area:not([disabled])');
    ok('options fetched once at load', calls.options.length === 1);
    ok('options URL targets the firm', calls.options[0].endsWith('/api/v1/firms/martinson-beason/scheduling-options'));

    const areaValues = await page.$$eval('#practice-area option', (os) => os.map((o) => o.value).filter((v) => v !== ''));
    ok('practice areas come from configuration', JSON.stringify(areaValues)
      === JSON.stringify(['personal-injury', 'family-law', 'military-law']), JSON.stringify(areaValues));
    ok('attorney disabled before a practice area is chosen', await page.isDisabled('#attorney'));

    await page.selectOption('#practice-area', 'personal-injury');
    const attorneyValues = await page.$$eval('#attorney option', (os) => os.map((o) => o.value));
    ok('attorneys filtered to the area\'s routing groups', JSON.stringify(attorneyValues)
      === JSON.stringify(['', 'clay-martinson', 'morris-lilienthal']), JSON.stringify(attorneyValues));
    ok('attorney enabled with No preference default', !(await page.isDisabled('#attorney'))
      && (await page.inputValue('#attorney')) === '');

    await page.selectOption('#practice-area', 'family-law');
    const familyValues = await page.$$eval('#attorney option', (os) => os.map((o) => o.value));
    ok('attorney list follows the selected area', JSON.stringify(familyValues)
      === JSON.stringify(['', 'raina-baugher']), JSON.stringify(familyValues));

    await page.selectOption('#practice-area', 'military-law');
    ok('unrouted area disables attorney with "No Attorneys Configured"',
      await page.isDisabled('#attorney')
      && (await page.textContent('#attorney option')).trim() === 'No Attorneys Configured');

    // Consultation types come from configuration and are required.
    const typeValues = await page.$$eval('#consultation-type-options input[type="radio"]',
      (radios) => radios.map((r) => r.value));
    ok('consultation types come from configuration', JSON.stringify(typeValues)
      === JSON.stringify(['initial-consultation', 'follow-up', 'existing-client']), JSON.stringify(typeValues));

    // The attorney is optional; the consultation type is not.
    await page.fill('#caller-name', 'No Attorney Needed');
    await page.fill('#caller-email', 'none@example.com');
    ok('prepare disabled until a consultation type is chosen', await page.isDisabled('#prepare-btn'));
    await page.click('label[for="ct-existing-client"]');
    ok('prepare enabled without an attorney once a type is chosen', !(await page.isDisabled('#prepare-btn')));
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])');
    const p = calls.create[0];
    ok('payload omits attorneyId and carries the practice area',
      !('attorneyId' in p.scheduling) && p.scheduling.practiceAreaId === 'military-law');
    ok('payload carries the chosen consultation type', p.scheduling.consultationTypeId === 'existing-client');
    ok('retired existingClient absent from payload', !('existingClient' in p.scheduling));
    await page.close();
  }
  {
    // Options load failure shows the error panel; retry recovers.
    const calls = newCalls();
    const page = await freshPage({
      options: ['abort', { status: 200, body: MOCK_OPTIONS }],
    }, calls);
    await page.waitForSelector('#error-panel:not([hidden])', { timeout: 15000 });
    ok('options failure shows error panel', true);
    ok('options failure status', (await page.textContent('#status-text')).trim() === 'Options unavailable');
    await page.click('#error-retry-btn');
    await page.waitForSelector('#caller-form:not([hidden])');
    await page.waitForSelector('#practice-area:not([disabled])');
    ok('retry reloads options and returns to the form', calls.options.length === 2);
    await page.close();
  }

  // ── apiBase override security ─────────────────────────────────────
  console.log('— apiBase override security —');
  {
    // PRODUCTION CONTEXT: serve the real page AT https://guideherd.ai via
    // interception, with a malicious ?apiBase. The console must ignore it.
    const page = await browser.newPage();
    const attackerCalls = [];
    const prodApiCalls = [];
    const pageHtml = fs.readFileSync(path.join(ROOT, 'receptionist', 'index.html'), 'utf8');

    await page.route('https://guideherd.ai/**', (route) =>
      route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: pageHtml }));
    await page.route('https://attacker.example/**', (route) => {
      attackerCalls.push(route.request().url());
      return route.fulfill({ status: 200, headers: CORS('https://guideherd.ai'), body: '{}' });
    });
    await page.route(API + '/**', async (route) => {
      const req = route.request();
      const origin = (await req.headerValue('origin')) || 'https://guideherd.ai';
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });
      prodApiCalls.push(req.url());
      if (req.method() === 'GET' && req.url().includes('/scheduling-options')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(MOCK_OPTIONS) });
      }
      return route.fulfill({ status: 201, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(createBody(600000)) });
    });

    await page.goto('https://guideherd.ai/receptionist/?apiBase=https://attacker.example');
    await fillRequired(page, 'Prod Victim');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 5000 });
    ok('production page ignores malicious ?apiBase (zero attacker requests)', attackerCalls.length === 0, attackerCalls.join(','));
    ok('production page always calls https://api.guideherd.ai', prodApiCalls.length >= 1 && prodApiCalls.every(u => u.startsWith(API)));
    await page.close();
  }
  {
    // LOCAL CONTEXT: a non-local override is rejected (falls back to prod)...
    const page = await browser.newPage();
    const attackerCalls = [];
    const prodApiCalls = [];
    await page.route('https://attacker.example/**', (route) => {
      attackerCalls.push(1);
      return route.fulfill({ status: 200, body: '{}' });
    });
    await page.route(API + '/**', async (route) => {
      const req = route.request();
      const origin = (await req.headerValue('origin')) || '*';
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });
      prodApiCalls.push(1);
      if (req.method() === 'GET' && req.url().includes('/scheduling-options')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(MOCK_OPTIONS) });
      }
      return route.fulfill({ status: 201, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(createBody(600000)) });
    });
    await page.goto(PAGE_URL + '?apiBase=https://attacker.example');
    await fillRequired(page, 'Local NonLocal');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 5000 });
    ok('non-local override rejected even on a local page', attackerCalls.length === 0 && prodApiCalls.length >= 1);
    await page.close();
  }
  {
    // ...while an allowlisted http://localhost:<port> override IS honored.
    const page = await browser.newPage();
    const localApiCalls = [];
    await page.route('http://localhost:4949/**', async (route) => {
      const req = route.request();
      const origin = (await req.headerValue('origin')) || '*';
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });
      localApiCalls.push(req.url());
      if (req.method() === 'GET' && req.url().includes('/scheduling-options')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(MOCK_OPTIONS) });
      }
      return route.fulfill({ status: 201, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(createBody(600000)) });
    });
    await page.goto(PAGE_URL + '?apiBase=http://localhost:4949');
    await fillRequired(page, 'Local Dev');
    await page.click('#prepare-btn');
    await page.waitForSelector('#ready-panel:not([hidden])', { timeout: 5000 });
    ok('local page honors http://localhost:<port> override', localApiCalls.length >= 1);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
