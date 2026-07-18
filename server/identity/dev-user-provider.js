'use strict';

/**
 * Development User Authentication Provider (ADR-0013) — the first user
 * authentication provider, deliberately boring.
 *
 * Exercises the COMPLETE authentication flow (credential → identity claim
 * → GuideHerd session) with zero external infrastructure, so the User
 * Session framework is fully built and testable before any enterprise
 * identity system arrives. Microsoft Entra, Google Workspace, Okta,
 * Auth0, Keycloak, and Authentik become "simply another provider" behind
 * the same contract.
 *
 * Users are defined in the deployment environment (secrets never live in
 * Configuration Store data):
 *
 *   GUIDEHERD_DEV_USERS='[
 *     { "key": "<login credential>", "subject": "jane-doe",
 *       "displayName": "Jane Doe", "organizationKey": "martinson-beason",
 *       "roles": ["receptionist"] }
 *   ]'
 *
 * Keys are held as SHA-256 digests; raw credentials are never retained,
 * logged, or attached to identities. This is NOT password authentication
 * (out of scope): keys are operator-provisioned opaque credentials for
 * development and controlled pilots — a production identity provider
 * replaces this via configuration, not via code changes.
 *
 * Malformed configuration refuses to construct (fail-fast boot pattern).
 */

const crypto = require('node:crypto');

const { InvalidCredentialsError, IdentityNotConfiguredError } = require('./errors');

const PROVIDER_KEY = 'dev-user';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{ devUsersJson?: string }} [options]
 */
function createDevUserProvider({ devUsersJson } = {}) {
  /** @type {Map<string, object>} credential digest -> identity claim */
  const usersByKeyHash = new Map();

  const fail = (reason) => {
    throw new Error(`Development user provider configuration is invalid: ${reason}`);
  };

  if (devUsersJson !== undefined && devUsersJson.trim() !== '') {
    let definitions;
    try {
      definitions = JSON.parse(devUsersJson);
    } catch {
      fail('GUIDEHERD_DEV_USERS is not valid JSON');
    }
    if (!Array.isArray(definitions)) fail('GUIDEHERD_DEV_USERS must be a JSON array');
    definitions.forEach((def, index) => {
      if (def === null || typeof def !== 'object') fail(`user ${index} is not an object`);
      const { key, ...claim } = def;
      if (typeof key !== 'string' || key.trim().length < 16) fail(`user ${index} needs a key of at least 16 characters`);
      if (typeof claim.subject !== 'string' || claim.subject.trim() === '') fail(`user ${index} has no subject`);
      if (typeof claim.organizationKey !== 'string' || claim.organizationKey.trim() === '') fail(`user ${index} has no organizationKey`);
      if (!Array.isArray(claim.roles) || claim.roles.length === 0) fail(`user ${index} has no roles`);
      usersByKeyHash.set(sha256(key), {
        subject: claim.subject,
        type: 'user',
        displayName: claim.displayName ?? null,
        organizationKey: claim.organizationKey,
        roles: claim.roles,
      });
    });
  }

  return {
    providerKey: PROVIDER_KEY,

    /** Number of configured users (observability/tests; never credentials). */
    size() {
      return usersByKeyHash.size;
    },

    /**
     * @param {{ credential?: string }} credentials opaque login payload
     * @returns {Promise<object>} identity claim (contract-validated upstream)
     */
    async authenticateUser({ credential } = {}) {
      if (usersByKeyHash.size === 0) throw new IdentityNotConfiguredError();
      if (typeof credential !== 'string' || credential === '') throw new InvalidCredentialsError();
      const claim = usersByKeyHash.get(sha256(credential));
      if (!claim) throw new InvalidCredentialsError();
      return { ...claim, roles: [...claim.roles] };
    },
  };
}

module.exports = { createDevUserProvider, PROVIDER_KEY };
