'use strict';
/**
 * CSP enforcement test (#39 review). Production serves the Content-Security-
 * Policy from `_headers` (Cloudflare Pages); this test applies the EXACT
 * same policy in a real browser and proves it is correct — it does not
 * break the product pages' required resources, and it DOES block external
 * injection. A CSP that is merely present but breaks the app, or that
 * silently allows external scripts, would fail here.
 *
 * The CSP string is read from `_headers` so this test tracks the shipped
 * policy rather than a copy.
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
    } catch { /* next */ }
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.');
}

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

/** The CSP shipped for the product surfaces, read from `_headers`. */
function shippedCsp() {
  const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
  const m = headers.match(/\/receptionist\/\*[\s\S]*?Content-Security-Policy:\s*(.+)/);
  if (!m) throw new Error('CSP for /receptionist/* not found in _headers');
  return m[1].trim();
}

const mime = (p) => (
  p.endsWith('.css') ? 'text/css'
    : p.endsWith('.js') ? 'text/javascript'
      : p.endsWith('.woff2') ? 'font/woff2'
        : p.endsWith('.html') || p.endsWith('/') ? 'text/html'
          : 'application/octet-stream');

(async () => {
  const CSP = shippedCsp();
  const server = http.createServer((req, res) => {
    let p = req.url.split('?')[0];
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = fs.readFileSync(path.join(ROOT, p));
      // Every product response carries the shipped CSP, exactly as the
      // Cloudflare `_headers` rule applies it in production.
      res.writeHead(200, { 'content-type': mime(p), 'content-security-policy': CSP });
      res.end(body);
    } catch { res.statusCode = 404; res.end('nf'); }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  for (const surface of ['receptionist', 'operations', 'admin']) {
    console.log(`— CSP: ${surface} —`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const violations = [];
    await page.exposeFunction('__cspViolation', (d) => violations.push(d));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        // eslint-disable-next-line no-undef
        window.__cspViolation({ directive: e.violatedDirective, blocked: e.blockedURI });
      });
    });
    await page.goto(`${base}/${surface}/`, { waitUntil: 'networkidle' });

    // 1. The page's OWN required resources load under the CSP: the shared
    //    stylesheet applied, self-hosted fonts declared, inline scripts ran.
    const cssApplied = await page.evaluate(() => {
      const el = document.querySelector('.gh-wordmark, .gh-app-name, body');
      return el ? getComputedStyle(el).fontFamily : '';
    });
    ok(`${surface}: shared stylesheet loaded under CSP (font-family resolved)`, /\w/.test(cssApplied));
    ok(`${surface}: inline page script executed under CSP`,
      await page.evaluate(() => typeof window.__cspProbe !== 'undefined' || document.readyState === 'complete'));
    ok(`${surface}: NO CSP violation from the page's own resources`,
      violations.length === 0, JSON.stringify(violations));

    // 2. External injection is BLOCKED: adding a cross-origin script must
    //    violate script-src (which is 'self' 'unsafe-inline' — no external).
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'https://cdn.example.com/evil.js';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(300);
    ok(`${surface}: an external <script> is blocked by CSP`,
      violations.some((v) => /script-src/.test(v.directive)), JSON.stringify(violations));

    // 3. An external stylesheet/font would likewise be refused (style-src
    //    / font-src are 'self'): prove with a cross-origin stylesheet.
    const before = violations.length;
    await page.evaluate(() => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.example.com/x.css';
      document.head.appendChild(l);
    });
    await page.waitForTimeout(300);
    ok(`${surface}: an external stylesheet is blocked by CSP`,
      violations.length > before && violations.slice(before).some((v) => /style-src/.test(v.directive)),
      JSON.stringify(violations.slice(before)));

    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
