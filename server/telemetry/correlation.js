'use strict';

/**
 * GuideHerd correlation identifiers (Issue #8).
 *
 * One GuideHerd-owned correlation ID exists per inbound request. It appears
 * in structured logs, controlled error responses, downstream operation
 * context, and the response header — so a support conversation, a log line,
 * and a failing request can be tied together without exposing anything
 * sensitive. The ID is opaque and carries no meaning: never a session
 * token, bearer token, phone number, email address, or caller name, and
 * never a provider's request id (provider ids may be recorded as SECONDARY
 * references in telemetry events).
 *
 * Inbound requests may supply an existing correlation ID, but supplying
 * one is a PRIVILEGE, not a default: syntax alone is never trust. Every
 * request starts with a freshly generated GuideHerd ID; a supplied
 * candidate is extracted (strict shape below) and ADOPTED only after the
 * request has authenticated as a trusted GuideHerd SERVICE identity
 * through the Identity Contract (ADR-0009). Anonymous requests,
 * browser/console clients, and capability-token requests always keep the
 * generated ID — arbitrary callers can never control operational log
 * identifiers. Shape validation applies even to trusted callers, so
 * unvalidated input can never reach logs (log-injection hygiene) and IDs
 * stay uniformly greppable.
 */

const crypto = require('node:crypto');

const CORRELATION_HEADER = 'x-guideherd-correlation-id';

/** Opaque, log-safe shape: 8–64 chars, alphanumeric plus . _ - */
const VALID_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

/** Generate a fresh GuideHerd correlation ID. */
function generateCorrelationId() {
  return 'gh-' + crypto.randomBytes(12).toString('hex');
}

/**
 * Extract a well-formed supplied correlation ID candidate, or null. The
 * candidate is NOT trusted by extraction — adoption requires an
 * authenticated GuideHerd service identity (see app.js).
 * @param {string|undefined} headerValue raw inbound header value, if any
 * @returns {string|null}
 */
function extractCandidateCorrelationId(headerValue) {
  if (typeof headerValue === 'string' && VALID_CORRELATION_ID.test(headerValue)) {
    return headerValue;
  }
  return null;
}

module.exports = { CORRELATION_HEADER, VALID_CORRELATION_ID, generateCorrelationId, extractCandidateCorrelationId };
