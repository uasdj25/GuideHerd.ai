'use strict';

/**
 * GuideHerd Connect domain errors.
 *
 * Same conventions as the handoff and config error families: each error
 * carries an HTTP status and a stable machine-readable code, and messages are
 * generic — never provider payloads, credentials, or internal state.
 */
class ConnectError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code stable error code
   * @param {string} message safe, generic description
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ConnectError';
    this.status = status;
    this.code = code;
  }

  toBody() {
    return { error: { code: this.code, message: this.message } };
  }
}

/**
 * A conversation provider is configured but no adapter is registered for it.
 * This is an explicit misconfiguration and fails loudly (503) rather than
 * silently falling back to a different provider.
 */
class ProviderUnavailableError extends ConnectError {
  constructor() {
    super(503, 'conversation_provider_unavailable', 'The configured conversation provider is not available.');
    this.name = 'ProviderUnavailableError';
  }
}

module.exports = { ConnectError, ProviderUnavailableError };
