'use strict';
/**
 * Browser regression tests for the GuideHerd Administration Center (#56,
 * ADR-0015 presentation per ADR-0019). All API traffic is mocked via request
 * interception — no production calls. The mocks mirror the real server's
 * shapes: /api/v1/auth/* (user sessions) and /api/v1/admin/* (administration
 * framework: describe(), audit, area apply with optimistic concurrency).
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

const IDENTITY = {
  subject: 'admin-user', displayName: 'Ada Admin', organizationKey: 'martinson-beason',
  roles: ['administrator'], expiresAt: '2026-07-19T07:00:00.000Z',
};

// The real describe() shape (server/administration/service.js): entities,
// settings keyed by camelCased domain id with { value, version, live }, and
// the registered identity providers.
function mockConfig(overrides = {}) {
  return {
    organization: { key: 'martinson-beason', name: 'Martinson & Beason, P.C.', displayName: 'Martinson & Beason', timezone: 'America/Chicago', active: true, version: 3 },
    practiceAreas: [
      { key: 'personal-injury', name: 'Personal Injury', active: true },
      { key: 'family-law', name: 'Family Law & Divorce', active: false },
    ],
    attorneys: [
      { key: 'clay-martinson', name: 'Clay Martinson', displayName: 'Clay Martinson', active: true },
      { key: 'raina-baugher', name: 'Raina Baugher', displayName: 'Raina Baugher', active: true },
    ],
    routingGroups: [
      { key: 'pi-group', name: 'Personal Injury Group', providers: ['clay-martinson', 'morris-lilienthal'] },
    ],
    locations: [
      { key: 'huntsville', name: 'Huntsville Office', timezone: 'America/Chicago' },
    ],
    settings: {
      schedulingPolicy: { value: { preferredTimeOfDay: 'morning' }, version: 5, live: true },
      notifications: { value: { enabled: false }, version: 1, live: true },
      notificationBranding: { value: { senderName: 'Martinson & Beason' }, version: 2, live: true },
      identityProvider: { value: { provider: 'static-token' }, version: 0, live: true },
      conversationProvider: { value: { provider: 'elevenlabs' }, version: 0, live: true },
      notificationProvider: { value: { provider: 'graph-email' }, version: 0, live: true },
      appointmentReminders: { value: { enabled: false }, version: 0, live: true },
    },
    registeredIdentityProviders: ['static-token', 'dev-user'],
    ...overrides,
  };
}

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

/**
 * behavior: { session, login, config, audit (array queue), apply(area, body) }
 * calls:    { session, login, logout, config, audit, apply[] }
 */
async function mockApi(page, behavior, calls) {
  await page.route(API + '/**', async (route) => {
    const req = route.request();
    const origin = (await req.headerValue('origin')) || 'http://127.0.0.1';
    const method = req.method();
    const url = req.url();
    const json = (status, body) => route.fulfill({
      status, headers: { 'content-type': 'application/json', ...CORS(origin) }, body: JSON.stringify(body),
    });

    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(origin) });

    if (method === 'GET' && url.endsWith('/api/v1/auth/session')) {
      calls.session.push(1);
      const b = behavior.session || { status: 200, body: IDENTITY };
      return json(b.status, b.body);
    }
    if (method === 'POST' && url.endsWith('/api/v1/auth/login')) {
      calls.login.push(JSON.parse(req.postData() || '{}'));
      const b = behavior.login || { status: 200, body: IDENTITY };
      return json(b.status, b.body);
    }
    if (method === 'POST' && url.endsWith('/api/v1/auth/logout')) {
      calls.logout.push(1);
      return route.fulfill({ status: 204, headers: CORS(origin), body: '' });
    }
    if (method === 'GET' && url.includes('/api/v1/admin/configuration')) {
      calls.config.push(1);
      const b = behavior.config || { status: 200, body: mockConfig() };
      return json(b.status, b.body);
    }
    if (method === 'GET' && url.includes('/api/v1/admin/audit')) {
      calls.audit.push(1);
      const queue = behavior.audit || [];
      const b = queue.length > 1 ? queue.shift() : queue[0];
      const resolved = b || { status: 200, body: { audit: [] } };
      if (resolved.delayMs) await new Promise((r) => setTimeout(r, resolved.delayMs));
      return json(resolved.status, resolved.body);
    }
    const areaMatch = url.match(/\/api\/v1\/admin\/([a-z][a-z-]*)$/);
    if (method === 'POST' && areaMatch) {
      const body = JSON.parse(req.postData() || '{}');
      calls.apply.push({ area: areaMatch[1], body });
      const b = behavior.apply ? behavior.apply(areaMatch[1], body) : { status: 200, body: { version: (body.expectedVersion || 0) + 1 } };
      return json(b.status, b.body);
    }
    return json(404, { error: { code: 'not_found', message: 'Resource not found.' } });
  });
}

function newCalls() { return { session: [], login: [], logout: [], config: [], audit: [], apply: [] }; }

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const PAGE_URL = base + '/admin/';
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  async function freshPage(behavior = {}, calls = newCalls(), viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await mockApi(page, behavior, calls);
    await page.goto(PAGE_URL);
    return { page, ctx };
  }

  // ── Branded sign-in ────────────────────────────────────────────────
  console.log('— Branded sign-in —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({ session: { status: 401, body: { error: { code: 'unauthorized' } } } }, calls);
    await page.waitForSelector('#login-wrap:not([hidden])');
    ok('signed out: gate shown, app hidden', await page.isVisible('#login-wrap') && !(await page.isVisible('#app')));
    ok('gate composes the shared card', (await page.getAttribute('.admin-login', 'class')).includes('gh-card'));
    ok('credential uses the shared input', (await page.getAttribute('#credential', 'class')).includes('gh-input'));
    ok('sign-in uses the shared primary button', !!(await page.$('#login button.gh-btn-primary')));
    ok('wordmark present on the gate', (await page.textContent('.admin-login .gh-wordmark')).includes('GuideHerd'));
    // Wrong credential fails closed with the server's message.
    await mockApi(page, { session: { status: 401, body: { error: { code: 'unauthorized' } } }, login: { status: 403, body: { error: { code: 'forbidden', message: 'The provided credential is not valid.' } } } }, calls);
    await page.fill('#credential', 'wrong-credential');
    await page.click('#login button[type=submit]');
    await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
    ok('wrong credential keeps the gate closed', !(await page.isVisible('#app')));
    ok('error is announced via role=alert', (await page.getAttribute('#login-error', 'role')) === 'alert');
    await ctx.close();
  }

  // ── Successful sign-in + entity listings ───────────────────────────
  console.log('— Sign-in and entity listings —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({}, calls);
    await page.waitForSelector('#app:not([hidden])');
    ok('session probe leads straight to the app', await page.isVisible('#app') && !(await page.isVisible('#login-wrap')));
    ok('identity chip names user and organization',
      (await page.textContent('#who')).trim() === 'Ada Admin — martinson-beason');
    ok('application header composes gh-app-header', !!(await page.$('header.gh-app-header .gh-app-name')));

    // Entity listings render as Design System tables with badges.
    const catalog = await page.textContent('#catalog');
    ok('practice areas listed', catalog.includes('Personal Injury') && catalog.includes('Family Law & Divorce'));
    ok('attorney keys rendered as mono', !!(await page.$('#catalog code.gh-mono')));
    ok('routing groups listed with ordered attorneys', catalog.includes('clay-martinson, morris-lilienthal'));
    ok('locations listed', catalog.includes('Huntsville Office'));
    ok('active/inactive shown as badges, not raw booleans',
      (await page.$$eval('#catalog .gh-badge', (els) => els.map((e) => e.textContent.trim()))).includes('Inactive')
      && !catalog.includes('true') && !catalog.includes('false'));
    ok('tables are the shared primitive', (await page.$$('#catalog table.gh-table')).length >= 3);

    // Form values loaded from the API (behavior parity with the old page).
    ok('organization fields populated', (await page.inputValue('#org-name')) === 'Martinson & Beason, P.C.');
    ok('policy time-of-day populated', (await page.inputValue('#pol-time')) === 'morning');
    ok('identity provider options from API', (await page.$$eval('#idp option', (o) => o.map((x) => x.value))).join(',') === 'static-token,dev-user');
    await ctx.close();
  }

  // ── Empty and loading states ───────────────────────────────────────
  console.log('— Empty and loading states —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({
      config: { status: 200, body: mockConfig({ practiceAreas: [], attorneys: [], routingGroups: [], locations: [] }) },
      audit: [{ status: 200, body: { audit: [] }, delayMs: 600 }],
    }, calls);
    await page.waitForSelector('#app:not([hidden])');
    ok('audit shows the shared loading state while fetching', !!(await page.$('#audit .gh-loading')));
    await page.waitForSelector('#audit .gh-empty');
    ok('empty audit uses the shared empty state', (await page.textContent('#audit .gh-empty')).includes('No changes yet'));
    ok('empty catalog uses the shared empty state', (await page.$$('#catalog .gh-empty')).length === 4);
    await ctx.close();
  }

  // ── Edit round-trip, validation failure, version conflict ──────────
  console.log('— Edit round-trip and failure paths —');
  {
    const calls = newCalls();
    const applied = [];
    const { page, ctx } = await freshPage({
      apply(area, body) {
        applied.push({ area, body });
        if (area === 'organization' && applied.length === 1) return { status: 200, body: { version: 4 } };
        if (area === 'scheduling-policy') return { status: 400, body: { error: { code: 'validation_error', message: 'preferredDurationMinutes must be between 5 and 480.' } } };
        if (area === 'notifications') return { status: 409, body: { error: { code: 'configuration_version_conflict', message: 'The configuration was changed by someone else. Reload and retry.' } } };
        return { status: 200, body: { version: (body.expectedVersion || 0) + 1 } };
      },
    }, calls);
    await page.waitForSelector('#app:not([hidden])');

    // Successful round-trip: payload + expectedVersion exactly as before.
    await page.fill('#org-name', 'Martinson & Beason, P.C. (updated)');
    const auditBefore = calls.audit.length;
    await page.click('#save-org');
    await page.waitForFunction(() => document.getElementById('msg-organization').textContent.includes('Saved'));
    ok('save posts to the same area endpoint', applied[0].area === 'organization');
    ok('payload carries the edited fields', applied[0].body.payload.name === 'Martinson & Beason, P.C. (updated)'
      && applied[0].body.payload.timezone === 'America/Chicago');
    ok('expectedVersion carries the loaded version token', applied[0].body.expectedVersion === 3);
    ok('success presents the shared ok alert',
      (await page.getAttribute('#msg-organization', 'class')).includes('gh-alert--ok'));
    ok('saved version echoed to the administrator', (await page.textContent('#msg-organization')).includes('version 4'));
    await page.waitForFunction((n) => n !== undefined, calls.audit.length);
    ok('audit reloads after a successful save', calls.audit.length > auditBefore);

    // Validation failure: the server's message, in the bad alert.
    await page.fill('#pol-duration', '9999');
    await page.click('#save-policy');
    await page.waitForFunction(() => document.getElementById('msg-scheduling-policy').textContent.includes('preferredDurationMinutes'));
    ok('validation failure presents the shared bad alert',
      (await page.getAttribute('#msg-scheduling-policy', 'class')).includes('gh-alert--bad'));

    // Version conflict: calm warn alert with reload guidance.
    await page.click('#save-notifications');
    await page.waitForFunction(() => document.getElementById('msg-notifications').textContent.includes('Changed by someone else'));
    ok('409 presents the shared warn alert with reload guidance',
      (await page.getAttribute('#msg-notifications', 'class')).includes('gh-alert--warn'));
    ok('conflict does not update the local version token', applied.some((a) => a.area === 'notifications' && a.body.expectedVersion === 1));
    await ctx.close();
  }

  // ── Live vs restart-required presentation ──────────────────────────
  console.log('— Live vs restart-required classification —');
  {
    const cfg = mockConfig();
    cfg.settings.identityProvider = { ...cfg.settings.identityProvider, live: false };
    const { page, ctx } = await freshPage({ config: { status: 200, body: cfg } }, newCalls());
    await page.waitForSelector('#app:not([hidden])');
    ok('live settings badged Live (ok tone)',
      (await page.textContent('#badge-scheduling-policy')).trim() === 'Live'
      && (await page.getAttribute('#badge-scheduling-policy .gh-badge', 'class')).includes('gh-badge--ok'));
    ok('restart-required settings badged distinctly (warn tone)',
      (await page.textContent('#badge-identity-provider')).trim() === 'Restart required'
      && (await page.getAttribute('#badge-identity-provider .gh-badge', 'class')).includes('gh-badge--warn'));
    await ctx.close();
  }

  // ── Accessibility structure ────────────────────────────────────────
  console.log('— Accessibility structure —');
  {
    const { page, ctx } = await freshPage({}, newCalls());
    await page.waitForSelector('#app:not([hidden])');
    ok('skip link targets main', (await page.getAttribute('.gh-skip-link', 'href')) === '#main'
      && !!(await page.$('main#main')));
    ok('every form control has a label', await page.$$eval('#app input.gh-input, #app select.gh-select', (els) =>
      els.every((e) => document.querySelector(`label[for="${e.id}"]`) !== null)));
    ok('save results are aria-live status regions', await page.$$eval('[id^="msg-"]', (els) =>
      els.length >= 6 && els.every((e) => e.getAttribute('role') === 'status' && e.getAttribute('aria-live') === 'polite')));
    ok('async regions (audit, catalog) are aria-live', (await page.getAttribute('#audit', 'aria-live')) === 'polite'
      && (await page.getAttribute('#catalog', 'aria-live')) === 'polite');
    // Keyboard: tab reaches the first field; focus ring styles come from the DS.
    await page.keyboard.press('Tab'); // skip link first
    const first = await page.evaluate(() => document.activeElement.className);
    ok('first tab stop is the skip link', String(first).includes('gh-skip-link'));
    await ctx.close();
  }

  // ── Sign-out and mobile viewport ───────────────────────────────────
  console.log('— Sign-out and responsive —');
  {
    const calls = newCalls();
    const { page, ctx } = await freshPage({}, calls);
    await page.waitForSelector('#app:not([hidden])');
    await page.click('#logout');
    await page.waitForSelector('#login-wrap:not([hidden])');
    ok('sign-out calls the endpoint and returns to the gate', calls.logout.length === 1 && !(await page.isVisible('#app')));
    await ctx.close();
  }
  {
    const { page, ctx } = await freshPage({}, newCalls(), { width: 390, height: 844 });
    await page.waitForSelector('#app:not([hidden])');
    ok('mobile: no horizontal scroll', await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1));
    ok('mobile: field rows collapse to one column', await page.$eval('.field-row', (e) =>
      getComputedStyle(e).gridTemplateColumns.split(' ').length === 1));
    await ctx.close();
  }
  {
    const { page, ctx } = await freshPage({ session: { status: 401, body: { error: { code: 'unauthorized' } } } }, newCalls(), { width: 390, height: 844 });
    await page.waitForSelector('#login-wrap:not([hidden])');
    ok('mobile: sign-in gate has no horizontal scroll', await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1));
    await ctx.close();
  }

  // ── The page carries no independent design tokens ──────────────────
  console.log('— ADR-0019 consumption contract —');
  {
    const html = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
    const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    ok('page links the shared stylesheet', html.includes('assets/guideherd.css'));
    ok('page defines no :root token block', !styleBlock.includes(':root'));
    ok('page defines no custom-property tokens', !/^\s*--[a-z-]+\s*:/m.test(styleBlock));
    ok('page sets no font-family except via shared tokens', !/font-family\s*:(?![^;]*var\(--)/.test(styleBlock));
    ok('page declares no colors of its own', !/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(styleBlock));
  }

  await browser.close();
  server.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
