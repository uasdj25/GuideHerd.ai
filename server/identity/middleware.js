'use strict';

/**
 * The identity middleware — the ONLY place in GuideHerd that reads a bearer
 * token for authentication (ADR-0009).
 *
 * Flow, per request surface that requires identity:
 *
 *   HTTP request
 *     └─ extract bearer credential            (here — and nowhere else)
 *         └─ resolve provider from config     (identity/provider setting;
 *                                              unknown providers fail loudly)
 *             └─ provider.authenticate()      (the configured provider ONLY)
 *                 └─ contract validation      (strict allowlist, provenance
 *                                              stamped)
 *                     └─ GuideHerdIdentity → Core
 *
 * Core receives the frozen GuideHerdIdentity and authorizes with
 * requireRole(); business logic never inspects credentials. The raw token
 * is a local variable in this function and is never logged, stored, thrown,
 * or attached to anything that outlives the call.
 *
 * Session capability credentials (handoff and console tokens) are NOT
 * identities — they are single-purpose, short-lived capabilities tied to
 * one session (ADR-0002) and deliberately stay outside this contract.
 */

const { UnauthenticatedError, InsufficientRoleError } = require('./errors');
const { validateIdentityClaim } = require('./contract');
const { resolveIdentityProviderKey } = require('./provider-config');

/**
 * @param {{
 *   registry: ReturnType<typeof import('./contract').createIdentityProviderRegistry>,
 *   configService?: object|null,
 * }} deps
 */
function createIdentityService({ registry, configService = null }) {
  return {
    /**
     * Authenticate an HTTP request into a GuideHerdIdentity.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {{ organizationKey?: string|null }} [scope] the organization
     *        whose configuration selects the provider, when known
     * @returns {Promise<import('./contract').GuideHerdIdentity>}
     * @throws {import('./errors').IdentityError}
     */
    async authenticate(req, { organizationKey = null } = {}) {
      const header = req.headers.authorization;
      if (typeof header !== 'string') throw new UnauthenticatedError();
      const match = header.match(/^Bearer\s+(\S+)$/);
      if (!match) throw new UnauthenticatedError();
      const bearerToken = match[1];

      const providerKey = resolveIdentityProviderKey(configService, organizationKey);
      const provider = registry.resolve(providerKey); // 503 when unregistered

      const claim = await provider.authenticate({ bearerToken });
      return validateIdentityClaim(claim, providerKey);
    },
  };
}

/**
 * Authorize: the identity must hold the given GuideHerd role.
 * @param {import('./contract').GuideHerdIdentity} identity
 * @param {string} role
 * @returns {import('./contract').GuideHerdIdentity} the identity, for chaining
 * @throws {InsufficientRoleError}
 */
function requireRole(identity, role) {
  if (!identity || !Array.isArray(identity.roles) || !identity.roles.includes(role)) {
    throw new InsufficientRoleError();
  }
  return identity;
}

module.exports = { createIdentityService, requireRole };
