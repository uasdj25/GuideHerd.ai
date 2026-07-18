'use strict';

/**
 * Neutral provider-failure errors (Issue #8).
 *
 * Raised at a provider/extension boundary AFTER the provider's dialect has
 * been translated into the GuideHerd taxonomy — provider error vocabulary
 * (Graph response bodies, HTTP client exceptions, driver codes) never
 * crosses the boundary. These errors are INTERNAL diagnostics: they carry
 * only safe fields (category, provider name, optional HTTP status and
 * provider request id) and are never returned to customers or callers
 * verbatim.
 */

const { ERROR_CATEGORIES } = require('./taxonomy');

class ProviderFailure extends Error {
  /**
   * @param {string} category a provider_* taxonomy category
   * @param {{ provider: string, retryable?: boolean, httpStatus?: number, providerRequestId?: string }} facts
   */
  constructor(category, { provider, retryable, httpStatus, providerRequestId } = {}) {
    if (!ERROR_CATEGORIES[category]) throw new TypeError(`Unknown error category: ${category}`);
    super(`Provider operation failed (${category}).`); // generic — never provider payloads
    this.name = 'ProviderFailure';
    this.category = category;
    this.provider = provider ?? null;
    this.retryable = typeof retryable === 'boolean' ? retryable : ERROR_CATEGORIES[category].retryable;
    this.httpStatus = httpStatus ?? null;
    this.providerRequestId = providerRequestId ?? null;
  }
}

const providerTimeout = (facts) => new ProviderFailure('provider_timeout', facts);
const providerUnavailable = (facts) => new ProviderFailure('provider_unavailable', facts);
const providerAuthenticationFailed = (facts) => new ProviderFailure('provider_authentication_failed', facts);
const providerRateLimited = (facts) => new ProviderFailure('provider_rate_limited', facts);
const providerRejectedRequest = (facts) => new ProviderFailure('provider_rejected_request', facts);

module.exports = {
  ProviderFailure,
  providerTimeout,
  providerUnavailable,
  providerAuthenticationFailed,
  providerRateLimited,
  providerRejectedRequest,
};
