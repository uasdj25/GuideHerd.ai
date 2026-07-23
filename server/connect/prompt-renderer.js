'use strict';

/**
 * Scheduling-assistant prompt rendering — the canonical law-firm prompt
 * template becomes a tenant-specific system prompt from Configuration
 * Store data only (SQLite; ADR-0004/ADR-0016). Operational caller and
 * session values are NOT template variables: they arrive at runtime
 * through the conversation tools (get_prepared_caller,
 * select_offered_slots, report_scheduling_outcome) and never touch this
 * module.
 *
 * Tenant values and their single sources of truth:
 *
 *   firm.displayName          organization.displayName (name when unset —
 *                             the store's established display convention)
 *   firm.city, firm.state     the organization's sole active location with
 *                             an address (region codes speak as full state
 *                             names); several candidates are ambiguous and
 *                             REFUSE to render rather than guess
 *   firm.timeZone             organization.timezone (IANA)
 *   firm.timeZoneDisplayName  connect/scheduling-prompt setting
 *   firm.closingMessage       connect/scheduling-prompt setting
 *   firm.defaultConsultationTypeDisplayName
 *                             scheduling/default-consultation-type (a
 *                             consultation-type KEY) resolved to the
 *                             catalog entity's name
 *
 * There is deliberately NO default-attorney value: when no attorney is
 * established, the workflow asks the caller which attorney they prefer.
 *
 * Rendering FAILS CLOSED: missing required configuration, an unknown
 * template variable, or any unresolved placeholder in the output throws —
 * a prompt with template syntax must never reach ElevenLabs.
 *
 * Rendering happens at provisioning/agent-update time, never in the live
 * call path: the runtime agent receives the already-rendered prompt, and
 * caller-specific values keep arriving through the conversation tools.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.join(__dirname, 'prompts', 'law-firm-scheduling.template.md');

const SETTINGS_NAMESPACE = 'connect';
const PROMPT_PROFILE_KEY = 'scheduling-prompt';

const LIMITS = Object.freeze({ timeZoneDisplayName: 64, closingMessage: 1000 });

/** USPS region codes spoken as full state names ("AL" reads as "Alabama"). */
const US_STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

/** Rendering refused: configuration is missing, ambiguous, or unresolved. */
class PromptConfigurationError extends Error {
  /**
   * @param {string} organizationKey
   * @param {string[]} problems every problem found, not just the first
   */
  constructor(organizationKey, problems) {
    super(`Cannot render the scheduling prompt for "${organizationKey}": ${problems.join('; ')}`);
    this.name = 'PromptConfigurationError';
    this.problems = problems;
  }
}

/**
 * Normalize the `connect/scheduling-prompt` settings document (the
 * domain's registered validator, ADR-0016). LENIENT: reads always yield a
 * usable value; a missing or malformed field degrades to null and is
 * reported — the renderer, not the read, decides that null is fatal.
 * @returns {{ value: { timeZoneDisplayName: string|null, closingMessage: string|null }, issues: string[] }}
 */
function normalizeSchedulingPromptProfile(raw) {
  const empty = { timeZoneDisplayName: null, closingMessage: null };
  if (raw === null || raw === undefined) return { value: empty, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      value: empty,
      issues: ['must be an object like { "timeZoneDisplayName": "Central Time", "closingMessage": "…" }'],
    };
  }
  const issues = [];
  for (const k of Object.keys(raw)) {
    if (!(k in LIMITS)) issues.push(`unknown field: ${k}`);
  }
  const field = (name) => {
    const v = raw[name];
    if (v === undefined || v === null) {
      issues.push(`${name} is required`);
      return null;
    }
    if (typeof v !== 'string' || v.trim() === '') {
      issues.push(`${name} must be a nonblank string`);
      return null;
    }
    if (v.length > LIMITS[name]) {
      issues.push(`${name} must be at most ${LIMITS[name]} characters`);
      return null;
    }
    return v.trim();
  };
  return {
    value: {
      timeZoneDisplayName: field('timeZoneDisplayName'),
      closingMessage: field('closingMessage'),
    },
    issues,
  };
}

/**
 * Substitute `{{ firm.<name> }}` variables into a template. Pure and
 * deterministic; the template's own formatting passes through untouched.
 * Throws when the template references a variable the firm object does not
 * define, and when ANY placeholder syntax survives in the output.
 * @param {string} template
 * @param {object} firm resolved tenant values
 * @param {string} organizationKey for error reporting only
 * @returns {string}
 */
function renderTemplate(template, firm, organizationKey) {
  const unknown = new Set();
  const rendered = template.replace(/\{\{\s*firm\.([A-Za-z0-9]+)\s*\}\}/g, (match, name) => {
    if (!(name in firm)) {
      unknown.add(name);
      return match;
    }
    return String(firm[name]);
  });
  if (unknown.size > 0) {
    throw new PromptConfigurationError(organizationKey,
      [`the template references unknown variables: ${[...unknown].map((n) => `firm.${n}`).join(', ')}`]);
  }
  assertNoUnresolvedPlaceholders(rendered);
  return rendered;
}

/**
 * Reject any rendered prompt still carrying template syntax — `{{ … }}`
 * remnants, stray double braces, or angle-bracket placeholder tokens like
 * `<law_firm>` / `<attorney>`. A prompt that fails here must never be
 * sent to ElevenLabs.
 * @param {string} text
 */
function assertNoUnresolvedPlaceholders(text) {
  const problems = [];
  const mustache = text.match(/\{\{[^}]*\}\}/g);
  if (mustache) problems.push(`unresolved template variables: ${[...new Set(mustache)].join(', ')}`);
  else if (/\{\{|\}\}/.test(text)) problems.push('stray template braces ({{ or }})');
  const angle = text.match(/<[A-Za-z][A-Za-z0-9_-]*>/g);
  if (angle) problems.push(`angle-bracket placeholders: ${[...new Set(angle)].join(', ')}`);
  if (problems.length > 0) {
    throw new Error(`Rendered prompt contains unresolved placeholders — refusing to provision: ${problems.join('; ')}`);
  }
}

/** Speakable state name for a location's region ("AL" → "Alabama"). */
function speakableRegion(region) {
  const trimmed = String(region).trim();
  return US_STATE_NAMES[trimmed.toUpperCase()] && trimmed.length === 2
    ? US_STATE_NAMES[trimmed.toUpperCase()]
    : trimmed;
}

/** Resolve tenant values and render — the shared internal pipeline. */
function resolveAndRender({ configService, organizationKey }) {
  if (!configService) {
    throw new PromptConfigurationError(String(organizationKey), ['a Configuration Store is required']);
  }
  const organization = configService.organizations.get(organizationKey); // throws unknown_organization
  const locations = configService.locations.list(organizationKey, {})
    .filter((l) => l.active !== false);

  // Consumer read via the Customer Configuration Framework (ADR-0016);
  // normalizeSchedulingPromptProfile above is the registered validator.
  // Lazy require, mirroring scheduling/policy.js, to avoid import cycles.
  const { readDomain } = require('../configuration/framework');
  const { value: profile } = readDomain(configService, 'scheduling-prompt', organizationKey);

  const problems = [];

  const displayName = organization.displayName || organization.name;
  if (!displayName) problems.push('the organization has no display name or name');
  if (!organization.timezone) problems.push('the organization has no timezone');

  const addressed = locations.filter((l) => l.city && l.region);
  let city = null;
  let state = null;
  if (addressed.length === 1) {
    city = addressed[0].city;
    state = speakableRegion(addressed[0].region);
  } else if (addressed.length === 0) {
    problems.push('no active location provides a city and region for the firm\'s spoken address');
  } else {
    problems.push(`several active locations (${addressed.map((l) => l.key).join(', ')}) provide a city and region — the firm's spoken address is ambiguous`);
  }

  if (!profile.timeZoneDisplayName) {
    problems.push(`missing required setting ${SETTINGS_NAMESPACE}/${PROMPT_PROFILE_KEY}: timeZoneDisplayName`);
  }
  if (!profile.closingMessage) {
    problems.push(`missing required setting ${SETTINGS_NAMESPACE}/${PROMPT_PROFILE_KEY}: closingMessage`);
  }

  // The default consultation type is a KEY resolved against the catalog
  // entity — the entity owns the display wording. There is deliberately
  // no default attorney: absent one, the workflow asks the caller.
  const { value: defaultConsultationTypeKey } = readDomain(configService, 'default-consultation-type', organizationKey);
  let defaultConsultationTypeDisplayName = null;
  if (!defaultConsultationTypeKey) {
    problems.push('missing required setting scheduling/default-consultation-type');
  } else {
    try {
      defaultConsultationTypeDisplayName = configService.consultationTypes.get(organizationKey, defaultConsultationTypeKey).name;
    } catch {
      problems.push(`scheduling/default-consultation-type references an unknown consultation type: ${defaultConsultationTypeKey}`);
    }
  }

  if (problems.length > 0) throw new PromptConfigurationError(organizationKey, problems);

  const firm = {
    displayName,
    city,
    state,
    timeZone: organization.timezone,
    timeZoneDisplayName: profile.timeZoneDisplayName,
    closingMessage: profile.closingMessage,
    defaultConsultationTypeDisplayName,
  };
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return { prompt: renderTemplate(template, firm, organizationKey), firm, template };
}

/**
 * Render the effective ElevenLabs system prompt for an organization from
 * the Configuration Store (SQLite) alone. Deterministic for identical
 * configuration; throws PromptConfigurationError (listing EVERY missing
 * or ambiguous value) rather than rendering a partial prompt.
 * @param {{ configService: object, organizationKey: string }} args
 * @returns {string} the rendered prompt, guaranteed placeholder-free
 */
function renderSchedulingPrompt({ configService, organizationKey }) {
  return resolveAndRender({ configService, organizationKey }).prompt;
}

/**
 * Render with PROVENANCE: everything needed to determine later which
 * template and configuration produced a deployed prompt. Deterministic
 * (no timestamps): the same template + configuration always yields the
 * same three hashes.
 * @param {{ configService: object, organizationKey: string }} args
 * @returns {{ prompt: string, provenance: {
 *   organizationKey: string,
 *   templatePath: string, templateSha256: string,
 *   configurationSha256: string,
 *   promptSha256: string,
 * } }}
 */
function renderSchedulingPromptArtifact({ configService, organizationKey }) {
  const { prompt, firm, template } = resolveAndRender({ configService, organizationKey });
  const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    prompt,
    provenance: {
      organizationKey,
      templatePath: path.relative(path.join(__dirname, '..'), TEMPLATE_PATH),
      templateSha256: sha256(template),
      // Canonical JSON of the resolved tenant values (stable key order).
      configurationSha256: sha256(JSON.stringify(firm, Object.keys(firm).sort())),
      promptSha256: sha256(prompt),
    },
  };
}

module.exports = {
  renderSchedulingPrompt,
  renderSchedulingPromptArtifact,
  renderTemplate,
  normalizeSchedulingPromptProfile,
  assertNoUnresolvedPlaceholders,
  PromptConfigurationError,
  TEMPLATE_PATH,
  SETTINGS_NAMESPACE,
  PROMPT_PROFILE_KEY,
};
