'use strict';

/**
 * Retention service tests (ADR-0006 / #63): the sweep resolves each
 * organization's policy (default or override), calls the store's purge,
 * emits counts-only telemetry, is tenant-scoped, and never throws.
 * Store-level purge semantics are covered by the shared contract suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { createTelemetry } = require('../telemetry/telemetry');
const { fixedClock } = require('../handoff/clock');
const { createRetentionService, DEFAULT_POLICY } = require('./retention');

const T0 = Date.parse('2026-07-12T15:15:00Z');
const H = 60 * 60 * 1000, D = 24 * H;

function fixture() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: 'org-a', name: 'A', timezone: 'UTC' });
  configService.organizations.create({ key: 'org-b', name: 'B', timezone: 'UTC' });
  return configService;
}

test('retention service: DEFAULT windows are ADR-0006 proposed (24h / 30d)', () => {
  assert.deepEqual(DEFAULT_POLICY, { cancelledExpiredHours: 24, terminalDays: 30 });
});

test('retention service: sweeps every org with its resolved policy; emits counts-only telemetry', async () => {
  const configService = fixture();
  // org-b overrides to tighter windows (2h / 7d).
  configService.settings.set('org-b', 'retention', 'policy', { cancelledExpiredHours: 2, terminalDays: 7 });

  const seen = [];
  const store = {
    async purgeRetired(orgKey, windows) {
      seen.push({ orgKey, windows });
      return orgKey === 'org-a' ? { purgedShortLived: 3, purgedTerminal: 1 } : { purgedShortLived: 0, purgedTerminal: 0 };
    },
  };
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
  const retention = createRetentionService({ store, configService, clock: fixedClock(T0), telemetry });

  const result = await retention.sweep();
  assert.deepEqual(result, { purgedShortLived: 3, purgedTerminal: 1 });

  const a = seen.find((x) => x.orgKey === 'org-a');
  const b = seen.find((x) => x.orgKey === 'org-b');
  assert.equal(a.windows.cancelledExpiredBeforeMs, T0 - 24 * H, 'org-a uses default 24h');
  assert.equal(a.windows.terminalBeforeMs, T0 - 30 * D, 'org-a uses default 30d');
  assert.equal(b.windows.cancelledExpiredBeforeMs, T0 - 2 * H, 'org-b override 2h');
  assert.equal(b.windows.terminalBeforeMs, T0 - 7 * D, 'org-b override 7d');

  // Telemetry only fires when something was purged, and carries counts only.
  const events = lines.filter((l) => l.event === 'guideherd.retention.swept');
  assert.equal(events.length, 1, 'only org-a purged anything');
  assert.equal(events[0].organizationKey, 'org-a');
  assert.equal(events[0].purgedShortLived, 3);
  assert.equal(events[0].purgedTerminal, 1);
  assert.equal(/caller|email|phone|@/.test(JSON.stringify(events)), false, 'no caller data in telemetry');
});

test('retention service: a per-org purge failure is isolated and never breaks the sweep', async () => {
  const configService = fixture();
  const store = {
    async purgeRetired(orgKey) {
      if (orgKey === 'org-a') throw new Error('store down');
      return { purgedShortLived: 2, purgedTerminal: 0 };
    },
  };
  const lines = [];
  const telemetry = createTelemetry({ log: (l) => lines.push(JSON.parse(l)), clock: fixedClock(T0) });
  const retention = createRetentionService({ store, configService, clock: fixedClock(T0), telemetry });
  const result = await retention.sweep(); // must not throw
  assert.deepEqual(result, { purgedShortLived: 2, purgedTerminal: 0 }, 'org-b still swept despite org-a failure');
  assert.ok(lines.some((l) => l.event === 'guideherd.internal.unexpected_error'));
});

test('retention service: no config service means defaults and no organizations to sweep', async () => {
  const store = { async purgeRetired() { throw new Error('should not be called'); } };
  const retention = createRetentionService({ store, configService: null, clock: fixedClock(T0) });
  assert.deepEqual(await retention.sweep(), { purgedShortLived: 0, purgedTerminal: 0 });
});
