'use strict';

/**
 * StaticTokenProvider — the first Identity Provider (ADR-0009).
 *
 * Authenticates long-lived service tokens defined in the deployment
 * environment (secrets are never Configuration Store data). Tokens are
 * hashed (SHA-256) at construction; raw token material is never retained,
 * logged, or attached to identities, and lookups compare digests the same
 * way the handoff store handles its token hashes.
 *
 * Configuration:
 *
 *   GUIDEHERD_STATIC_IDENTITIES — JSON array of identity definitions:
 *     [{ "token": "…", "subject": "reporting-job", "type": "service",
 *        "displayName": "Nightly reporting", "organizationKey": null,
 *        "roles": ["reporting"] }]
 *
 *   DEMO_BRIDGE_SECRET — absorbed as the scheduling-assistant service
 *     identity, so the live assistant integration graduates onto the
 *     Identity Contract with zero credential or behavior change. When the
 *     demo bridge dies, this absorption dies with it.
 *
 * Malformed configuration fails loudly at construction (the fail-fast boot
 * pattern the Operational Store established) — never a provider that
 * half-works.
 *
 * This provider is deliberately boring. Enterprise identity systems arrive
 * later as additional providers implementing the same contract; nothing
 * here or in Core changes when they do (ADR-0007 §4).
 */

const crypto = require('node:crypto');

const { InvalidCredentialsError, IdentityNotConfiguredError } = require('./errors');
const { IDENTITY_TYPES } = require('./contract');

const PROVIDER_KEY = 'static-token';

/** Role granted to the absorbed demo-bridge credential. */
const SCHEDULING_ASSISTANT_ROLE = 'scheduling-assistant';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{ staticIdentitiesJson?: string, demoBridgeSecret?: string }} [options]
 */
function createStaticTokenProvider({ staticIdentitiesJson, demoBridgeSecret } = {}) {
  /** @type {Map<string, object>} token digest -> identity claim */
  const identitiesByTokenHash = new Map();

  const fail = (reason) => {
    throw new Error(`StaticTokenProvider configuration is invalid: ${reason}`);
  };

  if (staticIdentitiesJson !== undefined && staticIdentitiesJson.trim() !== '') {
    let definitions;
    try {
      definitions = JSON.parse(staticIdentitiesJson);
    } catch {
      fail('GUIDEHERD_STATIC_IDENTITIES is not valid JSON');
    }
    if (!Array.isArray(definitions)) fail('GUIDEHERD_STATIC_IDENTITIES must be a JSON array');
    definitions.forEach((def, index) => {
      if (def === null || typeof def !== 'object') fail(`definition ${index} is not an object`);
      const { token, ...claim } = def;
      if (typeof token !== 'string' || token.trim() === '') fail(`definition ${index} has no token`);
      if (typeof claim.subject !== 'string' || claim.subject.trim() === '') fail(`definition ${index} has no subject`);
      if (!IDENTITY_TYPES.includes(claim.type)) fail(`definition ${index} has an invalid type`);
      if (claim.roles !== undefined && !Array.isArray(claim.roles)) fail(`definition ${index} has invalid roles`);
      identitiesByTokenHash.set(sha256(token), {
        subject: claim.subject,
        type: claim.type,
        displayName: claim.displayName ?? null,
        organizationKey: claim.organizationKey ?? null,
        roles: claim.roles ?? [],
      });
    });
  }

  // TEMPORARY DEMO INFRASTRUCTURE continuity: the bridge secret becomes the
  // scheduling-assistant service identity. Explicit definitions win on a
  // hash collision (an operator re-describing the same credential).
  if (typeof demoBridgeSecret === 'string' && demoBridgeSecret.trim() !== '') {
    const hash = sha256(demoBridgeSecret);
    if (!identitiesByTokenHash.has(hash)) {
      identitiesByTokenHash.set(hash, {
        subject: 'scheduling-assistant',
        type: 'service',
        displayName: 'GuideHerd Scheduling Assistant',
        organizationKey: null,
        roles: [SCHEDULING_ASSISTANT_ROLE],
      });
    }
  }

  return {
    providerKey: PROVIDER_KEY,

    /** Number of configured identities (observability/tests; never tokens). */
    size() {
      return identitiesByTokenHash.size;
    },

    /**
     * @param {{ bearerToken: string }} credentials
     * @returns {Promise<object>} identity claim (validated by the contract)
     */
    async authenticate({ bearerToken }) {
      if (identitiesByTokenHash.size === 0) throw new IdentityNotConfiguredError();
      const claim = identitiesByTokenHash.get(sha256(bearerToken));
      if (!claim) throw new InvalidCredentialsError();
      // A fresh object per authentication: callers can never mutate the
      // provider's configuration through a returned identity.
      return { ...claim, roles: [...claim.roles] };
    },
  };
}

module.exports = { createStaticTokenProvider, PROVIDER_KEY, SCHEDULING_ASSISTANT_ROLE };
