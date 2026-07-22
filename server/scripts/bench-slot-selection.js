'use strict';

/**
 * Deterministic LOCAL timing benchmark for the scheduling slot-selection seam
 * (#66). Measures two GuideHerd-local components over a realistic batch:
 *
 *   - engine  : selectOfferedSlots() — sanitize + hard business hours +
 *               deterministic policy ranking (pure computation).
 *   - route   : the full HTTP path in-process over loopback (parse → auth →
 *               config reads → engine → serialize). Loopback is not real
 *               network; this bounds the "GuideHerd HTTP route processing
 *               time" component only.
 *
 * It does NOT measure ElevenLabs→GuideHerd network latency or the calendar
 * provider lookup — those are external and must be measured during the
 * controlled post-demo voice test. Inputs are fixed (no randomness), so the
 * benchmark is reproducible; absolute numbers vary by machine.
 *
 *   Run: node --experimental-sqlite scripts/bench-slot-selection.js
 */

const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { createApp } = require('../handoff/app');
const { fixedClock } = require('../handoff/clock');
const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { selectOfferedSlots } = require('../scheduling/selection');

const FIRM = 'martinson-beason';
const CHI = 'America/Chicago';
const SECRET = 'bench-secret';
const T0 = Date.parse('2026-07-12T15:15:00Z');
const HOURS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opens: '09:00', closes: '17:00' }));
const ATTORNEYS = ['clay-martinson', 'raina-baugher', 'morris-lilienthal'];

// Near worst case: a Mon–Fri week, 09:00–16:30 every 30 min, one slot PER
// attorney (three), clamped to ~100 slots — the contract's practical batch
// that fits the 16 KB body limit, and well above a typical caller-facing
// offer, so the timing is a conservative local bound.
function weekOfSlots() {
  const slots = [];
  for (let day = 13; day <= 17; day++) {            // 2026-07-13 (Mon) .. 07-17 (Fri)
    for (let half = 0; half < 16; half++) {          // 09:00 .. 16:30 local
      const hour = 9 + Math.floor(half / 2);
      const min = half % 2 === 0 ? '00' : '30';
      const localZ = `2026-07-${day}T${String(hour).padStart(2, '0')}:${min}:00-05:00`;
      const startsAt = new Date(localZ).toISOString();
      for (const attorneyId of ATTORNEYS) slots.push({ startsAt, durationMinutes: 30, attorneyId });
    }
  }
  return slots.slice(0, 100);
}

// Caller-request preferences drive ranking here (attorney + duration) so the
// full scorer loop is exercised without writing the org policy — the settings
// store is only ever written through the Configuration Framework (ADR-0016),
// never directly. Business hours (the Intl-heavy hard constraint that dominates
// the timing) still come from the office configuration below. Org-level policy
// ranking has equivalent per-slot cost, so this bounds the seam either way.
const RANK_REQUEST = { attorneyId: 'clay-martinson', durationMinutes: 30 };

function configService() {
  const db = openDatabase();
  migrate(db);
  const cs = createConfigService({ db });
  cs.organizations.create({ key: FIRM, name: 'Martinson & Beason, P.C.', timezone: CHI });
  cs.locations.create(FIRM, { key: 'huntsville', name: 'Huntsville Office', timezone: CHI, officeHours: HOURS });
  return cs;
}

function pct(durations, p) {
  const s = [...durations].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const ms = (n) => n.toFixed(2);

async function main() {
  const cs = configService();
  const slots = weekOfSlots();
  const N = 1000, WARM = 100;

  // ── engine (selectOfferedSlots) ──
  for (let i = 0; i < WARM; i++) selectOfferedSlots({ configService: cs, organizationKey: FIRM, slots, request: RANK_REQUEST });
  const engine = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    selectOfferedSlots({ configService: cs, organizationKey: FIRM, slots, request: RANK_REQUEST });
    engine.push(performance.now() - t);
  }

  // ── full HTTP route (in-process, loopback) ──
  const app = createApp({
    demoBridgeSecret: SECRET, clock: fixedClock(T0),
    mailer: { enabled: false, async sendSummary() { return { status: 'not-configured' }; } },
    configService: cs,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = () => fetch(base + '/api/v1/scheduling/slot-selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ slots, request: RANK_REQUEST }),
  }).then((r) => r.json());

  for (let i = 0; i < WARM; i++) await call();
  const route = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await call();
    route.push(performance.now() - t);
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));

  console.log(`slot-selection LOCAL timing — ${slots.length} slots, ${N} iterations (loopback; NOT real network)`);
  console.log(`  engine (selectOfferedSlots): p50=${ms(pct(engine, 50))}ms  p95=${ms(pct(engine, 95))}ms`);
  console.log(`  http route (in-process):     p50=${ms(pct(route, 50))}ms  p95=${ms(pct(route, 95))}ms`);
  console.log('  NOTE: excludes ElevenLabs→GuideHerd network + calendar-provider lookup —');
  console.log('        those must be measured during the controlled post-demo voice test.');
}

main().catch((e) => { console.error(e); process.exit(1); });
