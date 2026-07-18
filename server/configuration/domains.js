'use strict';

/**
 * Production configuration domains (ADR-0016).
 *
 * Each registration COMPOSES a validator that the owning subsystem
 * authors and exports — ownership stays with the consumer; this module
 * only assembles the registry. Every settings domain is LIVE: consumers
 * read per request, so an administered change affects the very next
 * request.
 *
 * Provider-selection domains share one shape ({ provider }) with
 * per-domain defaults; their strict write-time rule (the provider must
 * be registered on the deployment) runs only when the producer supplies
 * the registry context — consumers stay fail-safe.
 */

const { normalizePolicy } = require('../scheduling/policy');
const { normalizeBrandingDocument } = require('../notifications/branding');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A `{ provider: string }` selection domain with a default key. */
function providerSelectionDomain({ id, title, owner, namespace, key, defaultProvider, registeredKeysContext }) {
  return {
    id,
    title,
    owner,
    namespace,
    key,
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { provider: defaultProvider }, issues: [] };
      if (!isPlainObject(raw)) {
        return { value: { provider: defaultProvider }, issues: ['must be an object like { "provider": "…" }'] };
      }
      const issues = [];
      for (const k of Object.keys(raw)) {
        if (k !== 'provider' && k !== 'agentId') issues.push(`unknown field: ${k}`);
      }
      const provider = typeof raw.provider === 'string' && raw.provider.trim() !== ''
        ? raw.provider.trim()
        : (issues.push('provider must be a nonblank string'), defaultProvider);
      const value = { provider };
      if (typeof raw.agentId === 'string' && raw.agentId.trim() !== '') value.agentId = raw.agentId.trim();
      return { value, issues };
    },
    validate(value, context) {
      const registered = context && context[registeredKeysContext];
      if (Array.isArray(registered) && !registered.includes(value.provider)) {
        return [`provider must be one of: ${registered.join(', ')}`];
      }
      return [];
    },
  };
}

/** Register every production settings domain on the given framework. */
function registerProductionDomains(framework) {
  // Scheduling policy — validator owned by the Scheduling Policy Engine.
  framework.register({
    id: 'scheduling-policy',
    title: 'Scheduling policy',
    owner: 'scheduling',
    namespace: 'scheduling',
    key: 'policy',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      const { policy, issues } = normalizePolicy(raw);
      return { value: policy, issues };
    },
  });

  // Notification branding — validator owned by the Notification Contract.
  framework.register({
    id: 'notification-branding',
    title: 'Notification branding',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'branding',
    live: true,
    schemaVersion: 1,
    normalize(raw, context) {
      return normalizeBrandingDocument(raw, context);
    },
  });

  // Notification enablement (appointment confirmations).
  framework.register({
    id: 'notifications',
    title: 'Notification enablement',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'appointment-confirmation',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { enabled: false }, issues: [] };
      const issues = [];
      if (!isPlainObject(raw)) {
        return { value: { enabled: false }, issues: ['must be an object like { "enabled": true }'] };
      }
      for (const k of Object.keys(raw)) {
        if (k !== 'enabled') issues.push(`unknown field: ${k}`);
      }
      if (typeof raw.enabled !== 'boolean') issues.push('enabled must be a boolean');
      return { value: { enabled: raw.enabled === true }, issues };
    },
  });

  framework.register(providerSelectionDomain({
    id: 'identity-provider',
    title: 'Identity provider selection',
    owner: 'identity',
    namespace: 'identity',
    key: 'provider',
    defaultProvider: 'static-token',
    registeredKeysContext: 'identityProviderKeys',
  }));

  framework.register(providerSelectionDomain({
    id: 'conversation-provider',
    title: 'Conversation provider selection',
    owner: 'connect',
    namespace: 'connect',
    key: 'conversation-provider',
    defaultProvider: 'elevenlabs',
    registeredKeysContext: 'conversationProviderKeys',
  }));

  framework.register(providerSelectionDomain({
    id: 'notification-provider',
    title: 'Notification provider selection',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'provider',
    defaultProvider: 'graph-email',
    registeredKeysContext: 'notificationProviderKeys',
  }));
}

/**
 * The store-backed ENTITY domains (documentation of the complete model;
 * their schema/validation live in the Configuration Store's normalizers
 * per ADR-0004, administered via ADR-0015 entity areas — all LIVE).
 */
const ENTITY_DOMAINS = Object.freeze([
  { id: 'organization', owner: 'configuration-store', live: true },
  { id: 'practice-areas', owner: 'configuration-store', live: true },
  { id: 'attorneys', owner: 'configuration-store', live: true },
  { id: 'consultation-types', owner: 'configuration-store', live: true },
  { id: 'routing-groups', owner: 'configuration-store', live: true },
  { id: 'locations-and-hours', owner: 'configuration-store', live: true },
]);

module.exports = { registerProductionDomains, ENTITY_DOMAINS };
