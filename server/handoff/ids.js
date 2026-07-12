'use strict';

const crypto = require('node:crypto');

// Human-readable prefix so a handoff token is recognizable in a request body.
// The prefix carries no secret; all entropy comes from the random suffix.
const TOKEN_PREFIX = 'gh_handoff_';

/**
 * Session identifier. A random UUID is used rather than a ULID so we do not add
 * a dependency purely to match the example format.
 * @returns {string}
 */
function generateSessionId() {
  return crypto.randomUUID();
}

/**
 * Single-use bearer token. 32 random bytes (256 bits) encoded base64url gives
 * an unguessable, URL-safe value with ample entropy.
 * @returns {string}
 */
function generateHandoffToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage. The raw bearer token is never persisted; only its
 * SHA-256 hash is kept and used for lookup.
 * @param {string} token
 * @returns {string} hex-encoded SHA-256 digest
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { generateSessionId, generateHandoffToken, hashToken, TOKEN_PREFIX };
