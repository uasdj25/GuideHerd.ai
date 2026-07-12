'use strict';

/**
 * Domain errors carry the HTTP status and a stable machine-readable code.
 *
 * Messages are deliberately generic and MUST NOT contain token material or
 * other sensitive input — errors are returned to callers and written to logs.
 */
class HandoffError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code stable error code
   * @param {string} message safe, generic description
   * @param {Array<{field: string, message: string}>} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HandoffError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  /** Public response body shape for this error. */
  toBody() {
    const error = { code: this.code, message: this.message };
    if (this.details) error.details = this.details;
    return { error };
  }
}

class ValidationError extends HandoffError {
  constructor(message, details) {
    super(400, 'validation_error', message, details);
    this.name = 'ValidationError';
  }
}

class MalformedRequestError extends HandoffError {
  constructor(message = 'Request body must be valid JSON.') {
    super(400, 'malformed_request', message);
    this.name = 'MalformedRequestError';
  }
}

class UnknownTokenError extends HandoffError {
  constructor() {
    super(404, 'unknown_token', 'The handoff token is not recognized.');
    this.name = 'UnknownTokenError';
  }
}

class TokenAlreadyRedeemedError extends HandoffError {
  constructor() {
    super(409, 'token_already_redeemed', 'The handoff token has already been redeemed.');
    this.name = 'TokenAlreadyRedeemedError';
  }
}

class TokenExpiredError extends HandoffError {
  constructor() {
    super(410, 'token_expired', 'The handoff token has expired.');
    this.name = 'TokenExpiredError';
  }
}

module.exports = {
  HandoffError,
  ValidationError,
  MalformedRequestError,
  UnknownTokenError,
  TokenAlreadyRedeemedError,
  TokenExpiredError,
};
