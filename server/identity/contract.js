'use strict';

/**
 * The GuideHerd Identity Contract (ADR-0009) — the permanent authentication
 * architecture of the platform, an extension family under ADR-0007.
 *
 * GuideHerd Core never authenticates. Core receives a **GuideHerdIdentity**
 * — a provider-neutral statement of WHO is calling, in GuideHerd domain
 * language — and authorizes against it. How that identity was established
 * (a static service token today; an enterprise identity system tomorrow) is
 * an Identity Provider's concern, invisible to business logic. Raw bearer
 * tokens are read in exactly one place (the identity middleware) and never
 * cross into Core, storage, events, or logs.
 *
 * @typedef {Object} GuideHerdIdentity
 * @property {string} subject          stable principal id (e.g.
 *                                     'scheduling-assistant'); never a token
 * @property {'service'|'user'} type   what kind of principal this is
 * @property {string|null} displayName human-readable name, when known
 * @property {string|null} organizationKey  the organization this identity is
 *                                     scoped to; null = platform-scoped
 * @property {string[]} roles          GuideHerd role names this identity
 *                                     holds (authorization vocabulary is
 *                                     GuideHerd-owned, never provider-owned)
 * @property {string} provider         provider key that authenticated this
 *                                     identity — stamped by the middleware,
 *                                     never by the provider itself
 *
 * An **Identity Provider** is a plain object implementing:
 *
 *   {
 *     // Stable provider key. Matches the Configuration Store setting
 *     // identity/provider.
 *     providerKey: 'static-token',
 *
 *     // Authenticate neutral credentials into an identity claim.
 *     //   credentials: { bearerToken }  — extracted by the middleware; a
 *     //   provider never touches the HTTP request.
 *     // Returns a GuideHerdIdentity claim (without `provider` — provenance
 *     // is stamped by the middleware). Throws an IdentityError subclass:
 *     //   InvalidCredentialsError    credential rejected
 *     //   IdentityNotConfiguredError provider has nothing to check against
 *     authenticate(credentials) -> Promise<identity claim>
 *   }
 *
 * Canonical validation lives HERE, with the contract (ADR-0007 §2): every
 * provider's claim passes the same strict allowlist below; a provider can
 * translate its dialect but can never loosen the contract or smuggle
 * provider payloads (or token material) into an identity.
 */

const { IdentityProviderUnavailableError, IdentityContractViolationError } = require('./errors');

const IDENTITY_TYPES = Object.freeze(['service', 'user']);

const LIMITS = Object.freeze({
  subject: 128,
  displayName: 200,
  organizationKey: 128,
  role: 64,
  roleCount: 32,
});

const ALLOWED_CLAIM_KEYS = Object.freeze(['subject', 'type', 'displayName', 'organizationKey', 'roles']);

function isNonblankString(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/**
 * Validate a provider's identity claim against the contract and return the
 * canonical, frozen GuideHerdIdentity. `providerKey` is stamped here — a
 * provider cannot claim provenance.
 *
 * Strict allowlist: unknown keys are a contract violation, so provider
 * payloads, credentials, or token material can never ride along.
 *
 * @param {unknown} claim the provider's returned identity claim
 * @param {string} providerKey the key of the provider that authenticated
 * @returns {GuideHerdIdentity}
 * @throws {IdentityContractViolationError}
 */
function validateIdentityClaim(claim, providerKey) {
  const violation = (reason) => {
    // The reason is logged server-side for operators; the thrown error
    // stays generic — contract violations are platform defects.
    console.error(JSON.stringify({
      level: 'error',
      message: 'Identity provider returned an invalid identity claim.',
      provider: providerKey,
      reason,
    }));
    return new IdentityContractViolationError();
  };

  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
    throw violation('claim is not an object');
  }
  for (const key of Object.keys(claim)) {
    if (!ALLOWED_CLAIM_KEYS.includes(key)) throw violation(`unknown claim key: ${key}`);
  }
  if (!isNonblankString(claim.subject, LIMITS.subject)) throw violation('invalid subject');
  if (!IDENTITY_TYPES.includes(claim.type)) throw violation('invalid type');
  if (claim.displayName !== undefined && claim.displayName !== null
    && !isNonblankString(claim.displayName, LIMITS.displayName)) {
    throw violation('invalid displayName');
  }
  if (claim.organizationKey !== undefined && claim.organizationKey !== null
    && !isNonblankString(claim.organizationKey, LIMITS.organizationKey)) {
    throw violation('invalid organizationKey');
  }
  if (!Array.isArray(claim.roles)
    || claim.roles.length > LIMITS.roleCount
    || !claim.roles.every((r) => isNonblankString(r, LIMITS.role))) {
    throw violation('invalid roles');
  }

  return Object.freeze({
    subject: claim.subject.trim(),
    type: claim.type,
    displayName: claim.displayName == null ? null : claim.displayName.trim(),
    organizationKey: claim.organizationKey == null ? null : claim.organizationKey.trim(),
    roles: Object.freeze(claim.roles.map((r) => r.trim())),
    provider: providerKey,
  });
}

/**
 * Identity provider registry — the same registry pattern as GuideHerd
 * Connect's Conversation Adapters. Resolution failures are an explicit
 * misconfiguration (503): GuideHerd never silently substitutes an identity
 * provider, and authentication succeeds ONLY through the configured one.
 */
function createIdentityProviderRegistry() {
  /** @type {Map<string, object>} */
  const providers = new Map();

  return {
    /** @param {{ providerKey: string, authenticate: Function }} provider */
    register(provider) {
      if (!provider || typeof provider.providerKey !== 'string' || provider.providerKey === ''
        || typeof provider.authenticate !== 'function') {
        throw new TypeError('An identity provider must declare a nonblank providerKey and authenticate().');
      }
      providers.set(provider.providerKey, provider);
      return provider;
    },

    /**
     * @param {string} providerKey
     * @throws {IdentityProviderUnavailableError} when none is registered
     */
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

module.exports = {
  validateIdentityClaim,
  createIdentityProviderRegistry,
  IDENTITY_TYPES,
  LIMITS,
};
