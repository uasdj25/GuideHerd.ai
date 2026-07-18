'use strict';

/**
 * The GuideHerd error taxonomy (Issue #8).
 *
 * A small, closed set of GuideHerd-owned error categories. Core, routes,
 * telemetry, and customer-facing mapping reason in THESE terms only;
 * provider-specific vocabulary (Microsoft Graph responses, PostgreSQL
 * error codes, telephony dialects) is translated into a category at the
 * provider/extension boundary and never crosses it (ADR-0007 hygiene).
 *
 * Categories also carry the platform's default retry stance. Retryability
 * here answers "could a retry ever help?" — whether a SPECIFIC operation
 * is actually retried also depends on duplication safety at its boundary
 * (see retry.js and the mailer boundary).
 */

const ERROR_CATEGORIES = Object.freeze({
  validation_error: { retryable: false },
  unauthorized: { retryable: false },
  forbidden: { retryable: false },
  not_found: { retryable: false },
  conflict: { retryable: false },
  rate_limited: { retryable: true },
  provider_unavailable: { retryable: true },
  provider_timeout: { retryable: true },
  provider_authentication_failed: { retryable: false },
  provider_rate_limited: { retryable: true },
  provider_rejected_request: { retryable: false },
  transient_internal_failure: { retryable: true },
  permanent_internal_failure: { retryable: false },
  unexpected_error: { retryable: false },
});

/** Public error codes with a category that the status alone would misfile. */
const CODE_CATEGORIES = Object.freeze({
  too_many_prepared_sessions: 'rate_limited',
  conversation_provider_unavailable: 'provider_unavailable',
  identity_provider_unavailable: 'provider_unavailable',
  identity_not_configured: 'permanent_internal_failure',
  demo_bridge_not_configured: 'permanent_internal_failure',
  config_unavailable: 'permanent_internal_failure',
  identity_contract_violation: 'permanent_internal_failure',
});

/** HTTP-status fallback for domain errors without a special-cased code. */
function categoryForStatus(status) {
  if (status === 400) return 'validation_error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 410) return 'conflict'; // gone = state conflict
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'provider_unavailable';
  return 'unexpected_error';
}

/**
 * Categorize any error into the taxonomy. Never throws.
 * @param {unknown} err
 * @returns {{ category: string, retryable: boolean }}
 */
function categorize(err) {
  // Provider-boundary errors carry their category explicitly.
  if (err && typeof err.category === 'string' && ERROR_CATEGORIES[err.category]) {
    return {
      category: err.category,
      retryable: typeof err.retryable === 'boolean' ? err.retryable : ERROR_CATEGORIES[err.category].retryable,
    };
  }
  // Domain errors (Handoff/Config/Connect/Identity families): stable code + status.
  if (err && typeof err.code === 'string' && typeof err.status === 'number') {
    const category = CODE_CATEGORIES[err.code] || categoryForStatus(err.status);
    return { category, retryable: ERROR_CATEGORIES[category].retryable };
  }
  return { category: 'unexpected_error', retryable: false };
}

module.exports = { ERROR_CATEGORIES, CODE_CATEGORIES, categorize, categoryForStatus };
