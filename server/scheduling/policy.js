'use strict';

/**
 * Scheduling Policy (ADR-0012) — GuideHerd's answer to "which available
 * time should we offer?"
 *
 * Policies belong to ORGANIZATIONS and live in the Configuration Store as
 * the `scheduling/policy` setting (ADR-0004 namespaced-setting pattern) —
 * configuration, never code, and ready for future Administration Portal
 * editing. No policy setting means no policy: the engine then preserves
 * today's behavior exactly (chronological availability, untouched).
 *
 * The model is deliberately a set of SMALL, COMPOSABLE preferences rather
 * than a rule engine. Each field is one preference dimension the engine
 * scores independently; dimensions add up, they never compete. Future
 * policies (attorney priority tiers, overflow attorneys, practice-area
 * routing, office location, language, vacation calendars, working hours,
 * virtual/in-person, existing-client priority, VIP routing) arrive as new
 * optional fields with their own scorers — additive, per ADR-0007 §4.
 *
 *   {
 *     "preferredAttorneys": ["clay-martinson", "morris-lilienthal"],
 *     "preferredDaysOfWeek": ["monday", "tuesday"],
 *     "preferredTimeOfDay": "morning",            // or "afternoon"
 *     "preferredDurationMinutes": 30,
 *     "preferredConsultationTypes": ["initial-consultation"]
 *   }
 *
 * Validation is fail-safe and field-by-field: a malformed field is
 * DROPPED (reported in `issues`) and every valid field still applies — a
 * typo in configuration can degrade a preference, never break scheduling.
 */

const DAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const TIMES_OF_DAY = Object.freeze(['morning', 'afternoon']);

const SETTINGS_NAMESPACE = 'scheduling';
const POLICY_KEY = 'policy';

function stringList(value, max = 32) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const cleaned = value
    .filter((v) => typeof v === 'string' && v.trim() !== '' && v.length <= 128)
    .map((v) => v.trim());
  return cleaned.length === value.length ? cleaned : null;
}

/**
 * Validate a raw policy document into the canonical policy (or null when
 * nothing valid remains). Never throws.
 * @param {unknown} raw
 * @returns {{ policy: object|null, issues: string[] }}
 */
function normalizePolicy(raw) {
  const issues = [];
  if (raw === null || raw === undefined) return { policy: null, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: null, issues: ['policy must be an object'] };
  }
  const policy = {};

  const attorneys = stringList(raw.preferredAttorneys);
  if (raw.preferredAttorneys !== undefined) {
    if (attorneys) policy.preferredAttorneys = attorneys;
    else issues.push('preferredAttorneys must be a nonempty list of attorney keys');
  }

  if (raw.preferredDaysOfWeek !== undefined) {
    const days = stringList(raw.preferredDaysOfWeek, 7);
    const normalized = days && days.map((d) => d.toLowerCase());
    if (normalized && normalized.every((d) => DAYS.includes(d))) {
      policy.preferredDaysOfWeek = [...new Set(normalized)];
    } else {
      issues.push('preferredDaysOfWeek must be weekday names');
    }
  }

  if (raw.preferredTimeOfDay !== undefined) {
    const value = typeof raw.preferredTimeOfDay === 'string' ? raw.preferredTimeOfDay.trim().toLowerCase() : '';
    if (TIMES_OF_DAY.includes(value)) policy.preferredTimeOfDay = value;
    else issues.push('preferredTimeOfDay must be "morning" or "afternoon"');
  }

  if (raw.preferredDurationMinutes !== undefined) {
    const value = raw.preferredDurationMinutes;
    if (Number.isInteger(value) && value >= 5 && value <= 480) policy.preferredDurationMinutes = value;
    else issues.push('preferredDurationMinutes must be an integer between 5 and 480');
  }

  if (raw.preferredConsultationTypes !== undefined) {
    const types = stringList(raw.preferredConsultationTypes);
    if (types) policy.preferredConsultationTypes = types;
    else issues.push('preferredConsultationTypes must be a nonempty list of consultation type keys');
  }

  // Unknown keys are reported (a typo'd future field should be visible)
  // but never break the valid dimensions.
  const KNOWN = ['preferredAttorneys', 'preferredDaysOfWeek', 'preferredTimeOfDay', 'preferredDurationMinutes', 'preferredConsultationTypes'];
  for (const key of Object.keys(raw)) {
    if (!KNOWN.includes(key)) issues.push(`unknown policy field: ${key}`);
  }

  return { policy: Object.keys(policy).length > 0 ? policy : null, issues };
}

/**
 * Resolve the organization's scheduling policy from the Configuration
 * Store. Fail-safe: no store, unknown organization, or absent/malformed
 * setting resolves to no policy — scheduling behavior is then unchanged.
 * @param {object|null} configService
 * @param {string} organizationKey
 * @returns {{ policy: object|null, issues: string[] }}
 */
function resolveSchedulingPolicy(configService, organizationKey) {
  if (!configService || !organizationKey) return { policy: null, issues: [] };
  // Consumer read via the Customer Configuration Framework (ADR-0016);
  // normalizePolicy above remains the domain's registered validator.
  const { readDomain } = require('../configuration/framework');
  const { value, issues } = readDomain(configService, 'scheduling-policy', organizationKey);
  return { policy: value, issues };
}

module.exports = { resolveSchedulingPolicy, normalizePolicy, SETTINGS_NAMESPACE, POLICY_KEY, DAYS, TIMES_OF_DAY };
