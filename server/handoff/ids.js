'use strict';

const crypto = require('node:crypto');

// Human-readable prefixes so each credential is recognizable in a request
// body. Prefixes carry no secret; all entropy comes from the random suffix.
const TOKEN_PREFIX = 'gh_handoff_';
const CONSOLE_TOKEN_PREFIX = 'gh_console_';

/**
 * Session identifier. A random UUID is used rather than a ULID so we do not add
 * a dependency purely to match the example format.
 * @returns {string}
 */
function generateSessionId() {
  return crypto.randomUUID();
}

/**
 * Single-use bearer token for the scheduling/voice side. 32 random bytes
 * (256 bits) encoded base64url gives an unguessable, URL-safe value.
 * @returns {string}
 */
function generateHandoffToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Console bearer token for the GuideHerd Console. Same entropy as the
 * handoff token but a distinct credential: it can only check status and
 * cancel — it can never redeem caller context.
 * @returns {string}
 */
function generateConsoleToken() {
  return CONSOLE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
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

module.exports = { generateSessionId, generateHandoffToken, generateConsoleToken, hashToken, TOKEN_PREFIX, CONSOLE_TOKEN_PREFIX };
