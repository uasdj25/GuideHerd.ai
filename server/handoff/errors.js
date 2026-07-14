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

class TokenCancelledError extends HandoffError {
  constructor() {
    super(410, 'token_cancelled', 'The handoff token is no longer valid.');
    this.name = 'TokenCancelledError';
  }
}

class UnauthorizedError extends HandoffError {
  constructor() {
    super(401, 'unauthorized', 'A bearer token is required.');
    this.name = 'UnauthorizedError';
  }
}

class ForbiddenError extends HandoffError {
  constructor() {
    super(403, 'forbidden', 'The provided credential is not valid for this session.');
    this.name = 'ForbiddenError';
  }
}

class UnknownSessionError extends HandoffError {
  constructor() {
    super(404, 'unknown_session', 'The session is not recognized.');
    this.name = 'UnknownSessionError';
  }
}

class CannotCancelError extends HandoffError {
  constructor() {
    super(409, 'cannot_cancel', 'The session can no longer be cancelled.');
    this.name = 'CannotCancelError';
  }
}

class SessionExpiredError extends HandoffError {
  constructor() {
    super(410, 'session_expired', 'The session has expired.');
    this.name = 'SessionExpiredError';
  }
}

class NoPreparedSessionError extends HandoffError {
  constructor() {
    super(404, 'no_prepared_session', 'No prepared session is awaiting transfer.');
    this.name = 'NoPreparedSessionError';
  }
}

class AmbiguousSessionError extends HandoffError {
  constructor() {
    super(409, 'ambiguous_prepared_sessions', 'More than one prepared session is awaiting transfer. Cancel extras and retry.');
    this.name = 'AmbiguousSessionError';
  }
}

class OutcomeConflictError extends HandoffError {
  constructor() {
    super(409, 'outcome_conflict', 'A different outcome has already been recorded for this session.');
    this.name = 'OutcomeConflictError';
  }
}

class InvalidOutcomeStateError extends HandoffError {
  constructor() {
    super(409, 'invalid_outcome_state', 'The session cannot accept an outcome in its current state.');
    this.name = 'InvalidOutcomeStateError';
  }
}

class NoCompletedSummaryError extends HandoffError {
  constructor() {
    super(404, 'no_completed_summary', 'No completed Consultation Summary exists yet.');
    this.name = 'NoCompletedSummaryError';
  }
}

class BridgeNotConfiguredError extends HandoffError {
  constructor() {
    super(503, 'demo_bridge_not_configured', 'The demonstration bridge is not configured.');
    this.name = 'BridgeNotConfiguredError';
  }
}

module.exports = {
  HandoffError,
  ValidationError,
  MalformedRequestError,
  UnknownTokenError,
  TokenAlreadyRedeemedError,
  TokenExpiredError,
  TokenCancelledError,
  UnauthorizedError,
  ForbiddenError,
  UnknownSessionError,
  CannotCancelError,
  SessionExpiredError,
  NoPreparedSessionError,
  AmbiguousSessionError,
  OutcomeConflictError,
  InvalidOutcomeStateError,
  BridgeNotConfiguredError,
  NoCompletedSummaryError,
};
