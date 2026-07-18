'use strict';

/**
 * The GuideHerd Integration Contract (ADR-0020) — the permanent boundary
 * for outbound system-to-system communication.
 *
 * The architectural sibling of the Notification Contract (ADR-0011):
 * Notifications own CUSTOMER-FACING communication, GuideHerd Connect owns
 * live CONVERSATION providers, and this contract owns RECORD-AND-DATA
 * exchange with business systems (practice management, calendars beyond
 * notifications, CRMs, billing). Business workflows state an integration
 * INTENT in GuideHerd domain language; an Integration Provider translates
 * it into its system's dialect. Providers never decide when, what, or for
 * whom (ADR-0007 §3).
 *
 * An IntegrationRequest (strict allowlist — unknown keys are rejected so
 * provider payloads and stray PII can never ride along):
 *
 *   {
 *     type,             one of INTEGRATION_TYPES
 *     organizationKey,  the firm this integration belongs to
 *     integrationKey,   GuideHerd idempotency key with the platform's key
 *                       grammar: '<type>:<logical-event-id>' — one logical
 *                       system-to-system effect per key, ever
 *     facts,            SAFE identifier facts only, per-type allowlisted.
 *                       Business truth is re-read by the provider boundary
 *                       at delivery time from GuideHerd stores — facts
 *                       carry identifiers and workflow-safe scalars, never
 *                       customer payload snapshots (no names, no emails,
 *                       no phones, no free text).
 *   }
 *
 * An Integration Provider is a plain object (the registry pattern shared
 * with Notifications/Connect/Identity):
 *
 *   {
 *     providerKey: 'demo-integration',
 *     // Deliver one integration effect. Returns
 *     //   { status: 'completed'|'failed'|'not-configured', providerRequestId? }
 *     // NEVER throws to Core; provider dialect errors are classified into
 *     // the GuideHerd taxonomy at this boundary with duplication-safe
 *     // `retryable` classification (the mailer's discipline: retry only
 *     // what provably was NOT accepted) and surface only as telemetry +
 *     // the neutral status.
 *     deliver({ request }, context) -> Promise<result>
 *   }
 */

/**
 * The integration type catalog — the platform's integration CAPABILITIES.
 * Types grow only when a workflow does; each entry declares the SAFE facts
 * its requests may carry. Provider selection is per-type (ADR-0020 §3):
 * an organization maps each capability to the provider that serves it.
 * Real types (matter sync, calendar push, billing) arrive with their
 * provider tickets.
 */
const INTEGRATION_TYPES = Object.freeze({
  // Synthetic demonstration types (ship dark; no production triggers).
  // TWO types exist so the per-capability provider-selection model is
  // exercised for real: one organization may route different integration
  // capabilities to different providers, or the same provider may serve
  // several capabilities.
  'demo-record-sync': Object.freeze({
    facts: Object.freeze(['sessionId', 'outcome', 'attorneyId', 'practiceAreaId', 'consultationTypeId']),
  }),
  'demo-calendar-sync': Object.freeze({
    facts: Object.freeze(['sessionId', 'attorneyId']),
  }),
});

const REQUEST_KEYS = Object.freeze(['type', 'organizationKey', 'integrationKey', 'facts']);
const LIMITS = Object.freeze({ key: 256, string: 254, facts: 32 });

/** The idempotency-key grammar: '<type>:<logical-event-id>'. */
const KEY_GRAMMAR = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9:._-]*$/;

function isNonblank(v, max = LIMITS.string) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

/**
 * Validate and canonicalize an IntegrationRequest. Throws TypeError on any
 * violation — an invalid request is a programming error at the call site,
 * never a runtime condition.
 */
function validateIntegrationRequest(request) {
  const fail = (reason) => { throw new TypeError(`Invalid IntegrationRequest: ${reason}`); };
  if (request === null || typeof request !== 'object') fail('not an object');
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key)) fail(`unknown key ${key}`);
  }
  const typeDef = INTEGRATION_TYPES[request.type];
  if (!typeDef) fail('unknown type');
  if (!isNonblank(request.organizationKey, 128)) fail('organizationKey required');
  if (!isNonblank(request.integrationKey, LIMITS.key)) fail('integrationKey required');
  const integrationKey = request.integrationKey.trim();
  if (!KEY_GRAMMAR.test(integrationKey)) fail('integrationKey must follow <type>:<logical-event-id>');
  if (!integrationKey.startsWith(`${request.type}:`)) fail('integrationKey must be namespaced by its type');

  const facts = request.facts;
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) fail('facts required');
  const keys = Object.keys(facts);
  if (keys.length > LIMITS.facts) fail('too many facts');
  const canonical = {};
  for (const key of keys) {
    if (!typeDef.facts.includes(key)) fail(`fact ${key} is not allowed for ${request.type}`);
    const value = facts[key];
    const scalar = (typeof value === 'string' && value.length <= LIMITS.string)
      || typeof value === 'number' || typeof value === 'boolean';
    if (!scalar) fail(`fact ${key} must be a bounded scalar`);
    canonical[key] = typeof value === 'string' ? value.trim() : value;
  }

  return {
    type: request.type,
    organizationKey: request.organizationKey.trim(),
    integrationKey,
    facts: canonical,
  };
}

/**
 * Integration provider registry — resolution failures are explicit
 * misconfiguration, never a silent substitute (ADR-0007 §6; the
 * Notifications/Connect/Identity registry pattern).
 */
function createIntegrationProviderRegistry() {
  /** @type {Map<string, object>} */
  const providers = new Map();
  return {
    register(provider) {
      if (!provider || typeof provider.providerKey !== 'string' || provider.providerKey === ''
        || typeof provider.deliver !== 'function') {
        throw new TypeError('An integration provider must declare a nonblank providerKey and deliver().');
      }
      providers.set(provider.providerKey, provider);
      return provider;
    },
    resolve(providerKey) {
      const provider = providers.get(providerKey);
      if (!provider) {
        const err = new Error('The configured integration provider is not available.');
        err.code = 'integration_provider_unavailable';
        err.category = 'permanent_internal_failure';
        throw err;
      }
      return provider;
    },
    keys() {
      return [...providers.keys()];
    },
  };
}

module.exports = { INTEGRATION_TYPES, KEY_GRAMMAR, validateIntegrationRequest, createIntegrationProviderRegistry };
