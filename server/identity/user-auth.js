'use strict';

/**
 * User Authentication Providers (ADR-0013) — the adapter contract for
 * establishing WHO a browser user is.
 *
 * A User Authentication Provider answers exactly one question — "do these
 * login credentials identify a GuideHerd user, and who?" — and answers it
 * with a GuideHerd identity CLAIM. Everything provider-specific (OAuth,
 * OIDC, Entra, Google, Authentik, Auth0, Keycloak dialects, token
 * exchanges, redirects) lives entirely inside a provider implementation;
 * Core sees only the claim, which passes the same contract validation as
 * every identity in the platform (ADR-0009), and authorization remains
 * entirely GuideHerd's (ADR-0010). A provider claim can NEVER directly
 * become a permission: claims carry GuideHerd role NAMES, and only the
 * authorization policy decides what a role permits. Mapping external
 * provider groups to GuideHerd roles is future per-organization
 * configuration inside the provider boundary.
 *
 * Provider shape (registry pattern shared with Connect/Identity/
 * Notifications):
 *
 *   {
 *     providerKey: 'dev-user',
 *     // credentials is the OPAQUE login payload from the login request —
 *     // its interpretation is entirely the provider's. Returns an
 *     // identity claim ({ subject, type: 'user', displayName?,
 *     // organizationKey, roles }) or throws an IdentityError subclass.
 *     authenticateUser(credentials) -> Promise<identity claim>
 *   }
 *
 * The ACTIVE provider is deployment configuration:
 * GUIDEHERD_USER_AUTH_PROVIDER (default 'dev-user'). An explicitly
 * configured but unregistered provider fails loudly at login — never a
 * silent substitute. Adding Microsoft Entra, Google Workspace, Okta,
 * Auth0, Keycloak, or Authentik later is: one provider implementation,
 * one registration, configuration — no Core change.
 */

const { IdentityProviderUnavailableError } = require('./errors');

const DEFAULT_USER_AUTH_PROVIDER = 'dev-user';

/** Resolve the active user-authentication provider key from deployment env. */
function resolveUserAuthProviderKey(env = process.env) {
  const value = env.GUIDEHERD_USER_AUTH_PROVIDER;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_USER_AUTH_PROVIDER;
}

/** Registry for user-authentication providers; unknown keys fail loudly. */
function createUserAuthProviderRegistry() {
  /** @type {Map<string, object>} */
  const providers = new Map();
  return {
    register(provider) {
      if (!provider || typeof provider.providerKey !== 'string' || provider.providerKey === ''
        || typeof provider.authenticateUser !== 'function') {
        throw new TypeError('A user authentication provider must declare a nonblank providerKey and authenticateUser().');
      }
      providers.set(provider.providerKey, provider);
      return provider;
    },
    resolve(providerKey) {
      const provider = providers.get(providerKey);
      if (!provider) throw new IdentityProviderUnavailableError();
      return provider;
    },
    keys() {
      return [...providers.keys()];
    },
  };
}

module.exports = { createUserAuthProviderRegistry, resolveUserAuthProviderKey, DEFAULT_USER_AUTH_PROVIDER };
