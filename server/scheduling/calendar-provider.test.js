'use strict';

/**
 * Calendar Provider Contract (ADR-0024 / GitLab #75).
 *
 * The reference provider is certified by the SAME conformance suite every
 * real provider must pass — it is the contract's executable
 * specification. The purity test below is the enforcement of "no
 * Scheduling Core module imports provider-specific code": native-core
 * files may not name any external calendar service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createReferenceCalendarProvider } = require('./calendar-provider');
const { runCalendarProviderContractSuite } = require('./calendar-provider-contract-suite');

runCalendarProviderContractSuite('reference provider', () => {
  const provider = createReferenceCalendarProvider();
  return {
    provider,
    givenCalendar: provider.givenCalendar,
    injectFailure: provider.injectFailure,
    attempts: provider.attempts,
    eventsOn: provider.eventsOn,
  };
});

/**
 * Native Scheduling Core purity: these files ARE the provider-neutral
 * core. They must never name a concrete calendar service — a provider
 * identifier appearing here means business behavior is leaking across
 * the provider boundary. Grows as native-core modules land (#76+).
 */
const NATIVE_CORE_FILES = [
  'calendar-provider.js',
  'calendar-provider-contract-suite.js',
];
const PROVIDER_IDENTIFIERS = [/calcom/i, /cal\.com/i, /graph\.microsoft/i, /msgraph/i, /googleapis/i, /workspace/i];

/** Comments may explain portability ("a Google Workspace provider later");
 *  CODE may not touch a provider. Strip comments, scan what executes. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('native scheduling core CODE names no concrete calendar provider', () => {
  for (const file of NATIVE_CORE_FILES) {
    const source = stripComments(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    for (const pattern of PROVIDER_IDENTIFIERS) {
      assert.ok(!pattern.test(source), `${file} must not match ${pattern}`);
    }
  }
});

test('reference provider fault injection is one-shot — the next call succeeds cleanly', async () => {
  const provider = createReferenceCalendarProvider();
  provider.givenCalendar('cal-1', {});
  provider.injectFailure('fetchBusyIntervals', 'timeout');
  await assert.rejects(provider.fetchBusyIntervals({
    calendarRef: 'cal-1',
    startUtcMs: Date.parse('2026-09-01T00:00:00Z'),
    endUtcMs: Date.parse('2026-09-02T00:00:00Z'),
  }));
  const { intervals } = await provider.fetchBusyIntervals({
    calendarRef: 'cal-1',
    startUtcMs: Date.parse('2026-09-01T00:00:00Z'),
    endUtcMs: Date.parse('2026-09-02T00:00:00Z'),
  });
  assert.deepEqual(intervals, []);
});
