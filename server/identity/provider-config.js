'use strict';

/**
 * Identity-provider configuration — the same pattern as GuideHerd Connect's
 * conversation-provider setting (ADR-0004: new configuration families start
 * as namespaced settings):
 *
 *   namespace: "identity"
 *   key:       "provider"
 *   value:     { "provider": "static-token", ... }
 *
 * SECRETS NEVER GO HERE — the settings table is exportable configuration.
 * The setting names WHICH provider authenticates an organization's
 * requests; credentials stay in the process environment (or, later, in the
 * external identity system itself).
 *
 * Resolution is fail-safe toward the platform default: when the store is
 * absent, the organization is unknown, or the setting is missing/malformed,
 * the default provider applies. A setting that names a provider explicitly
 * is honored verbatim — if no provider is registered for it, authentication
 * fails loudly (503) rather than silently substituting. Authentication
 * succeeds ONLY through the configured provider.
 */

const DEFAULT_IDENTITY_PROVIDER = 'static-token';
const SETTINGS_NAMESPACE = 'identity';
const SETTINGS_KEY = 'provider';

/**
 * Resolve the active identity-provider key for an organization (or the
 * platform default when no organization scope applies).
 * @param {ReturnType<typeof import('../config/service').createConfigService>|null} configService
 * @param {string|null} organizationKey
 * @returns {string} provider key
 */
function resolveIdentityProviderKey(configService, organizationKey) {
  if (!configService || !organizationKey) return DEFAULT_IDENTITY_PROVIDER;
  let setting;
  try {
    setting = configService.settings.get(organizationKey, SETTINGS_NAMESPACE, SETTINGS_KEY);
  } catch {
    return DEFAULT_IDENTITY_PROVIDER;
  }
  const value = setting && setting.value;
  if (value && typeof value === 'object' && typeof value.provider === 'string' && value.provider.trim() !== '') {
    return value.provider.trim();
  }
  return DEFAULT_IDENTITY_PROVIDER;
}

module.exports = {
  resolveIdentityProviderKey,
  DEFAULT_IDENTITY_PROVIDER,
  SETTINGS_NAMESPACE,
  SETTINGS_KEY,
};
