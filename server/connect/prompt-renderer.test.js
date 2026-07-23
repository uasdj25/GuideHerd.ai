'use strict';

/**
 * Scheduling-prompt rendering tests: the Martinson & Beason prompt renders
 * from Configuration Store (SQLite) data alone, every tenant value
 * substitutes correctly, missing configuration refuses loudly, unresolved
 * placeholders never survive, rendering stays out of the live call path,
 * provenance is deterministic, and the Issue #66 workflow text is
 * preserved verbatim by the abstraction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const {
  renderSchedulingPrompt,
  renderSchedulingPromptArtifact,
  renderTemplate,
  normalizeSchedulingPromptProfile,
  assertNoUnresolvedPlaceholders,
  PromptConfigurationError,
  TEMPLATE_PATH,
} = require('./prompt-renderer');

const FIRM = 'martinson-beason';
const SEED_FILE = path.join(__dirname, '..', 'config', 'data', 'martinson-beason.example.json');

/** A config service seeded with the real Martinson & Beason document. */
function seededConfigService() {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.importOrganization(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
  return configService;
}

/** A minimal organization with none of the prompt configuration. */
function bareConfigService(orgKey = 'bare-firm') {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: orgKey, name: 'Bare Firm', timezone: 'America/Chicago' });
  return configService;
}

/** The seeded firm minus ONE piece of prompt configuration. */
function seededWithout(namespace, key) {
  const configService = seededConfigService();
  configService.settings.remove(FIRM, namespace, key);
  return configService;
}

test('prompt: the Martinson & Beason prompt renders from SQLite configuration — every tenant value substituted', () => {
  const configService = seededConfigService();
  const prompt = renderSchedulingPrompt({ configService, organizationKey: FIRM });

  // Firm display name (organization.displayName, not the legal name).
  assert.ok(prompt.includes('You are the scheduling assistant for Martinson & Beason. The caller has'),
    'firm display name substitutes into the opening');
  assert.ok(!prompt.includes('Martinson & Beason, P.C.'), 'the legal name is not the spoken name');

  // City/state from the sole active location; region code speaks as a state name.
  assert.match(prompt, /The law firm is located in Huntsville, Alabama\./, 'city and state substitute');
  assert.ok(!/Huntsville,\s*AL\b/.test(prompt), 'the USPS region code is never spoken');

  // Timezone ID (both uses) and display name (all three uses).
  assert.match(prompt, /appointment times in America\/Chicago \(Central Time\)/, 'timezone ID and display name');
  assert.match(prompt, /Include timezone\s+America\/Chicago\./, 'outcome reporting carries the timezone ID');
  assert.match(prompt, /convert them to Central Time before speaking/, 'time-zone section conversion');
  assert.match(prompt, /Convert UTC to Central Time before speaking/, 'workflow step 9 conversion');
  assert.match(prompt, /Convert UTC to Central Time\./, 'workflow step 11 fallback conversion');

  // The approved tenant-neutral guardrail — prepared-session values win;
  // no tenant default attorney exists or is required.
  assert.match(prompt, /Never substitute a different attorney or consultation\s+type when different values were returned by get_prepared_caller/,
    'the approved tenant-neutral guardrail renders');
  assert.ok(!prompt.includes('Mr. Martinson'), 'no demo-specific attorney wording renders');
  assert.match(prompt, /If no attorney has been provided, ask which attorney the\s+caller would prefer/,
    'without an established attorney the workflow asks the caller');
  assert.match(prompt, /use\s+Initial Consultation as the default/,
    'the configured default consultation type renders in the workflow');

  // Closing message, whole and exact.
  assert.ok(prompt.includes('"Thank you for calling Martinson & Beason. We look forward to speaking with you. Have a wonderful day."'),
    'the configured closing message renders whole');

  // Deterministic: identical configuration -> identical output.
  assert.equal(renderSchedulingPrompt({ configService, organizationKey: FIRM }), prompt);
});

test('prompt: the canonical template carries NO tenant values — only variables, and no default-attorney variable', () => {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  for (const tenantValue of ['Martinson & Beason', 'Mr. Martinson', 'Initial Consultation',
    'Huntsville', 'Alabama', 'America/Chicago', 'Central Time']) {
    assert.ok(!template.includes(tenantValue), `canonical template must not contain "${tenantValue}"`);
  }
  for (const variable of ['{{ firm.displayName }}', '{{ firm.city }}', '{{ firm.state }}',
    '{{ firm.timeZone }}', '{{ firm.timeZoneDisplayName }}', '{{ firm.closingMessage }}',
    '{{ firm.defaultConsultationTypeDisplayName }}']) {
    assert.ok(template.includes(variable), `canonical template must use ${variable}`);
  }
  assert.ok(!template.includes('defaultAttorneyDisplayName'),
    'no default-attorney variable exists — absent an attorney, the workflow asks the caller');
  assert.match(template, /Never substitute a different attorney or consultation\s+type when different values were returned by get_prepared_caller/,
    'the canonical guardrail is the approved tenant-neutral sentence');
});

test('prompt: no default-attorney configuration exists — and none is required to render', () => {
  const { domainDescriptors } = require('../configuration/framework');
  const ids = domainDescriptors().map((d) => d.id);
  assert.ok(!ids.includes('default-attorney'), 'no default-attorney configuration domain is registered');
  assert.ok(ids.includes('default-consultation-type'), 'the default consultation type domain remains');

  // The seeded firm configures NO default attorney anywhere — and renders.
  const configService = seededConfigService();
  const seededSettings = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).settings;
  assert.ok(!seededSettings.some((s) => s.key === 'default-attorney'), 'the seed carries no default attorney');
  assert.ok(renderSchedulingPrompt({ configService, organizationKey: FIRM }).length > 0);
});

test('prompt: the Issue #66 scheduling-policy workflow text is preserved by the abstraction', () => {
  const prompt = renderSchedulingPrompt({ configService: seededConfigService(), organizationKey: FIRM });
  assert.match(prompt, /call the select_offered_slots tool exactly once/);
  assert.match(prompt, /Pass every\s+slot returned by Get Available Slots/);
  assert.match(prompt, /Never filter, reorder, or invent\s+slots before calling the tool/);
  assert.match(prompt, /Pass the sessionId only if one was returned by\s+get_prepared_caller/);
  assert.match(prompt, /Present only\s+the first two returned appointment options/);
  assert.match(prompt, /Preserve the returned\s+order/);
  assert.match(prompt, /timeout, network failure, HTTP\s+500, or HTTP 503/);
  assert.match(prompt, /Fall back to the original Get Available Slots\s+results/);
  assert.match(prompt, /fails for any other\s+reason: - Apologize\. - Do not offer appointment times/);
  assert.match(prompt, /report_scheduling_outcome tool exactly once/);
});

test('prompt: missing required configuration refuses to render and lists every gap', () => {
  // No prompt profile, no default type, no addressed location: ALL reported.
  const bare = bareConfigService();
  assert.throws(() => renderSchedulingPrompt({ configService: bare, organizationKey: 'bare-firm' }),
    (err) => err instanceof PromptConfigurationError
      && /timeZoneDisplayName/.test(err.message)
      && /closingMessage/.test(err.message)
      && /default-consultation-type/.test(err.message)
      && !/default-attorney/.test(err.message)
      && /city and region/.test(err.message));

  // An unknown organization fails loudly, never silently.
  assert.throws(() => renderSchedulingPrompt({ configService: bare, organizationKey: 'no-such-org' }),
    (err) => err.code === 'unknown_organization');
});

test('prompt: the default consultation type is required — and must reference a real catalog entity', () => {
  // Missing entirely: refuses, names the setting.
  const noType = seededWithout('scheduling', 'default-consultation-type');
  assert.throws(() => renderSchedulingPrompt({ configService: noType, organizationKey: FIRM }),
    (err) => err instanceof PromptConfigurationError && /default-consultation-type/.test(err.message));

  // A dangling catalog reference is a configuration error, not a guess.
  const dangling = seededConfigService();
  dangling.settings.set(FIRM, 'scheduling', 'default-consultation-type', 'no-such-type');
  assert.throws(() => renderSchedulingPrompt({ configService: dangling, organizationKey: FIRM }),
    (err) => err instanceof PromptConfigurationError && /unknown consultation type: no-such-type/.test(err.message));
});

test('prompt: several addressed locations are ambiguous — refuse rather than guess', () => {
  const configService = seededConfigService();
  configService.locations.create(FIRM, {
    key: 'athens', name: 'Athens Office', city: 'Athens', region: 'AL', active: true,
  });
  assert.throws(() => renderSchedulingPrompt({ configService, organizationKey: FIRM }),
    (err) => err instanceof PromptConfigurationError && /ambiguous/.test(err.message));
});

test('prompt: unresolved placeholders are detected and rejected', () => {
  // Mustache remnants, stray braces, and angle-bracket tokens all fail.
  assert.throws(() => assertNoUnresolvedPlaceholders('Welcome to {{ firm.displayName }}.'), /firm\.displayName/);
  assert.throws(() => assertNoUnresolvedPlaceholders('By {{ firm.defaultAttorneyDisplayName }}'), /defaultAttorneyDisplayName/);
  assert.throws(() => assertNoUnresolvedPlaceholders('Use {{ firm.defaultConsultationTypeDisplayName }}'), /defaultConsultationTypeDisplayName/);
  assert.throws(() => assertNoUnresolvedPlaceholders('Stray }} braces'), /stray template braces/i);
  assert.throws(() => assertNoUnresolvedPlaceholders('Call <law_firm> today'), /<law_firm>/);
  assert.throws(() => assertNoUnresolvedPlaceholders('Ask for <attorney>'), /<attorney>/);
  assert.doesNotThrow(() => assertNoUnresolvedPlaceholders('A clean rendered prompt.'));

  // A template referencing an unknown variable refuses to render.
  assert.throws(() => renderTemplate('Hello {{ firm.nonsense }}', { displayName: 'X' }, 'firm-x'),
    (err) => err instanceof PromptConfigurationError && /firm\.nonsense/.test(err.message));

  // The rendered production prompt is placeholder-free end to end.
  const prompt = renderSchedulingPrompt({ configService: seededConfigService(), organizationKey: FIRM });
  assert.doesNotThrow(() => assertNoUnresolvedPlaceholders(prompt));
});

test('prompt: profile normalization — lenient reads, strict field rules', () => {
  assert.deepEqual(normalizeSchedulingPromptProfile(null),
    { value: { timeZoneDisplayName: null, closingMessage: null }, issues: [] });
  const missing = normalizeSchedulingPromptProfile({});
  assert.equal(missing.value.timeZoneDisplayName, null);
  assert.ok(missing.issues.some((i) => /timeZoneDisplayName is required/.test(i)));
  const junk = normalizeSchedulingPromptProfile({ timeZoneDisplayName: '  Central Time ', closingMessage: 'Bye.', extra: 1 });
  assert.equal(junk.value.timeZoneDisplayName, 'Central Time');
  assert.ok(junk.issues.some((i) => /unknown field: extra/.test(i)));
  const blank = normalizeSchedulingPromptProfile({ timeZoneDisplayName: '', closingMessage: 42 });
  assert.equal(blank.value.timeZoneDisplayName, null);
  assert.equal(blank.value.closingMessage, null);
  assert.equal(blank.issues.length, 2);
});

test('prompt: rendering provenance is complete and deterministic — the deployed prompt is traceable', () => {
  const configService = seededConfigService();
  const first = renderSchedulingPromptArtifact({ configService, organizationKey: FIRM });
  const again = renderSchedulingPromptArtifact({ configService, organizationKey: FIRM });

  // Deterministic: identical inputs -> identical prompt AND hashes.
  assert.deepEqual(again, first);

  const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(first.provenance.organizationKey, FIRM);
  assert.equal(first.provenance.templateSha256, sha256(fs.readFileSync(TEMPLATE_PATH, 'utf8')),
    'template hash matches the canonical template on disk');
  assert.equal(first.provenance.promptSha256, sha256(first.prompt), 'prompt hash matches the rendered prompt');
  assert.match(first.provenance.configurationSha256, /^[0-9a-f]{64}$/);
  assert.ok(first.provenance.templatePath.includes('law-firm-scheduling.template.md'));

  // A configuration change is visible in the configuration hash.
  configService.settings.set(FIRM, 'connect', 'scheduling-prompt',
    { timeZoneDisplayName: 'Central Time', closingMessage: 'Goodbye from the firm.' });
  const changed = renderSchedulingPromptArtifact({ configService, organizationKey: FIRM });
  assert.notEqual(changed.provenance.configurationSha256, first.provenance.configurationSha256);
  assert.notEqual(changed.provenance.promptSha256, first.provenance.promptSha256);
  assert.equal(changed.provenance.templateSha256, first.provenance.templateSha256);
});

test('prompt: tenant prompt configuration lives in SQLite only — PostgreSQL is structurally out of this path', () => {
  // The renderer and its CLI never touch the Operations Store: no pg,
  // no operational module, no connection string — the same structural
  // guarantee style as the ADR-0016 conformance scan.
  for (const file of ['prompt-renderer.js', path.join('..', 'scripts', 'render-scheduling-prompt.js')]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!/require\(['"]pg['"]\)/.test(source), `${file} must not require pg`);
    assert.ok(!/operational/.test(source), `${file} must not reach the Operations Store`);
    assert.ok(!/DATABASE_URL|postgres/i.test(source), `${file} must not reference PostgreSQL`);
  }
  // And rendering succeeds with a SQLite-backed config service alone (no
  // operational store exists anywhere in these tests).
  assert.ok(renderSchedulingPrompt({ configService: seededConfigService(), organizationKey: FIRM }).length > 0);
});

test('prompt: rendering stays OUT of the live call path — only provisioning code touches the renderer', () => {
  // Structural scan (the ADR-0016 conformance style): the only production
  // modules that may reference the prompt renderer are the configuration
  // domain registry (validator registration) and the provisioning CLI.
  // The runtime request path (handoff, connect conversations, correlation)
  // must never render prompts per call.
  const root = path.resolve(__dirname, '..');
  const sanctioned = new Set([
    path.join('connect', 'prompt-renderer.js'),
    path.join('configuration', 'domains.js'),
    path.join('scripts', 'render-scheduling-prompt.js'),
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      const rel = path.relative(root, full);
      if (sanctioned.has(rel)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/prompt-renderer|renderSchedulingPrompt/.test(source)) offenders.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [],
    'prompt rendering leaked into the runtime path — render at provisioning/agent-update time only');
});
