'use strict';

/**
 * GuideHerd User Sessions (ADR-0013) — the permanent framework for
 * authenticated browser users.
 *
 * Authentication providers establish WHO a user is (an identity claim);
 * GuideHerd establishes the authenticated SESSION: creation, validation,
 * expiration, invalidation, and rotation are all GuideHerd's, and
 * authorization stays entirely inside ADR-0010's boundary. No provider
 * artifact — token, cookie, claim set — ever becomes a session by itself.
 *
 * Session credentials are opaque GuideHerd tokens (256-bit random,
 * `gh_usession_` prefix), delivered ONLY as an HttpOnly cookie and stored
 * server-side ONLY as SHA-256 hashes — browser JavaScript can never read
 * them, and a database/store leak reveals no usable credential. Sessions
 * carry the VALIDATED GuideHerd identity claim (never provider tokens,
 * never raw provider claims).
 *
 * Fixation and replay posture:
 *  - login ALWAYS issues a fresh token, and any session presented with
 *    the login request is invalidated first — a pre-authentication cookie
 *    can never become an authenticated session (fixation protection);
 *  - logout invalidates server-side immediately; an expired or
 *    invalidated token is dead regardless of what a client replays;
 *  - absolute TTL bounds the replay window of a stolen cookie; HttpOnly +
 *    Secure + SameSite=Strict (set at the HTTP layer) bound theft itself.
 *
 * The store is a small contract (create/get/delete with lazy expiry).
 * The in-memory implementation is the reference; a restart logs users
 * out (re-login, no data loss). A durable PostgreSQL store joins the
 * activation path before multi-instance production enforcement —
 * documented in ADR-0013, deliberately not built while enforcement is
 * dark.
 */

const crypto = require('node:crypto');

const { validateIdentityClaim } = require('./contract');
const { UnauthenticatedError } = require('./errors');

const SESSION_TOKEN_PREFIX = 'gh_usession_';
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours, absolute

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** In-memory reference implementation of the session store contract. */
function createInMemoryUserSessionStore({ clock }) {
  /** @type {Map<string, { claim: object, providerKey: string, createdAtMs: number, expiresAtMs: number }>} */
  const sessions = new Map();
  return {
    async create(tokenHash, record) {
      sessions.set(tokenHash, record);
    },
    /** Lazy expiry: an expired record is removed on access. */
    async get(tokenHash) {
      const record = sessions.get(tokenHash);
      if (!record) return undefined;
      if (clock.now() >= record.expiresAtMs) {
        sessions.delete(tokenHash);
        return undefined;
      }
      return record;
    },
    async delete(tokenHash) {
      sessions.delete(tokenHash);
    },
    async size() {
      return sessions.size;
    },
  };
}

/**
 * @param {{
 *   store?: ReturnType<typeof createInMemoryUserSessionStore>,
 *   clock: import('../handoff/clock').Clock,
 *   ttlSeconds?: number,
 * }} deps
 */
function createUserSessionService({ store, clock, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS }) {
  const sessions = store || createInMemoryUserSessionStore({ clock });

  return {
    ttlSeconds,

    /**
     * Establish an authenticated session from a VALIDATED identity claim.
     * Always issues a fresh token (rotation); the caller passes any token
     * presented with the login request so it is invalidated first
     * (fixation protection).
     *
     * @param {object} claim a provider identity claim (validated here)
     * @param {string} providerKey the authenticating provider
     * @param {{ presentedToken?: string|null }} [options]
     * @returns {Promise<{ token: string, identity: object, expiresAtMs: number }>}
     */
    async establish(claim, providerKey, { presentedToken } = {}) {
      // Contract-owned validation: a provider can never loosen the identity
      // shape, and provenance is stamped here — not claimed (ADR-0009).
      const identity = validateIdentityClaim(claim, providerKey);
      if (identity.type !== 'user') {
        // Sessions are for USERS; service identities authenticate per
        // request with bearer credentials (ADR-0009) and never get cookies.
        throw new UnauthenticatedError();
      }

      if (presentedToken) {
        await sessions.delete(hashToken(presentedToken)); // rotate: old cookie dies
      }

      const token = SESSION_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
      const now = clock.now();
      await sessions.create(hashToken(token), {
        identity,
        createdAtMs: now,
        expiresAtMs: now + ttlSeconds * 1000,
      });
      return { token, identity, expiresAtMs: now + ttlSeconds * 1000 };
    },

    /**
     * Validate a presented session token into its GuideHerd identity.
     * @param {string|undefined|null} token
     * @returns {Promise<{ identity: object, expiresAtMs: number }|null>} null when
     *          absent, unknown, invalidated, or expired — callers fail closed.
     */
    async validate(token) {
      if (typeof token !== 'string' || !token.startsWith(SESSION_TOKEN_PREFIX)) return null;
      const record = await sessions.get(hashToken(token));
      if (!record) return null;
      return { identity: record.identity, expiresAtMs: record.expiresAtMs };
    },

    /** Invalidate a session (logout). Absent/unknown tokens are a no-op. */
    async invalidate(token) {
      if (typeof token === 'string' && token !== '') {
        await sessions.delete(hashToken(token));
      }
    },

    /** Store handle (tests/introspection). */
    store: sessions,
  };
}

module.exports = {
  createUserSessionService,
  createInMemoryUserSessionStore,
  SESSION_TOKEN_PREFIX,
  DEFAULT_SESSION_TTL_SECONDS,
};
