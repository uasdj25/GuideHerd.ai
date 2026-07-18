'use strict';

/**
 * Conversation-provider configuration.
 *
 * The active provider for an organization lives in the Configuration Store
 * as a namespaced setting (per ADR-0004, new configuration families start as
 * settings):
 *
 *   namespace: "connect"
 *   key:       "conversation-provider"
 *   value:     { "provider": "elevenlabs", ... }
 *
 * Additional non-secret provider reference data (e.g. the public assistant
 * agent id) may ride along in the same value. SECRETS NEVER GO HERE — the
 * settings table is exportable configuration; credentials such as
 * DEMO_BRIDGE_SECRET stay in the process environment.
 *
 * Resolution is fail-safe toward today's working demo: when the store is
 * absent, the organization is unknown, or the setting is missing/malformed,
 * the default provider applies. A setting that names a provider explicitly,
 * however, is honored verbatim — if no adapter is registered for it, the
 * request fails loudly (503) rather than silently switching providers.
 */

const DEFAULT_PROVIDER = 'elevenlabs';
const SETTINGS_NAMESPACE = 'connect';
const SETTINGS_KEY = 'conversation-provider';

/**
 * Resolve the active conversation-provider key for an organization.
 * @param {ReturnType<typeof import('../config/service').createConfigService>|null} configService
 * @param {string} firmId organization key
 * @returns {string} provider key
 */
function resolveProviderKey(configService, firmId) {
  if (!configService) return DEFAULT_PROVIDER;
  // Consumer read via the Customer Configuration Framework (ADR-0016):
  // unknown organizations and unset/malformed settings resolve to the
  // default, keeping the current integration working unconfigured.
  const { readDomain } = require('../configuration/framework');
  return readDomain(configService, 'conversation-provider', firmId).value.provider;
}

module.exports = {
  resolveProviderKey,
  DEFAULT_PROVIDER,
  SETTINGS_NAMESPACE,
  SETTINGS_KEY,
};
