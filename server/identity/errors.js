'use strict';

/**
 * Identity domain errors — same conventions as the handoff, config, and
 * connect error families: each error carries an HTTP status and a stable
 * machine-readable code, and messages are generic. Never a token, a
 * credential fragment, or provider internals: identity errors are returned
 * to callers and written to logs.
 *
 * Status codes deliberately mirror the platform's existing authentication
 * semantics (401 missing/malformed credential, 403 credential not accepted,
 * 503 explicit misconfiguration) so surfaces that migrate onto the Identity
 * Contract keep their public behavior.
 */
class IdentityError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code stable error code
   * @param {string} message safe, generic description
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
    this.code = code;
  }

  toBody() {
    return { error: { code: this.code, message: this.message } };
  }
}

/** No usable credential was presented (missing or malformed header). */
class UnauthenticatedError extends IdentityError {
  constructor() {
    super(401, 'unauthorized', 'A bearer token is required.');
    this.name = 'UnauthenticatedError';
  }
}

/** A credential was presented and the configured provider rejected it. */
class InvalidCredentialsError extends IdentityError {
  constructor() {
    super(403, 'forbidden', 'The provided credential is not valid.');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * The authenticated identity does not hold a role the surface requires.
 * Externally indistinguishable from an invalid credential on purpose.
 */
class InsufficientRoleError extends IdentityError {
  constructor() {
    super(403, 'forbidden', 'The provided credential is not valid.');
    this.name = 'InsufficientRoleError';
  }
}

/**
 * An identity provider is configured but no provider is registered for it.
 * Explicit misconfiguration: fails loudly, never silently substitutes.
 */
class IdentityProviderUnavailableError extends IdentityError {
  constructor() {
    super(503, 'identity_provider_unavailable', 'The configured identity provider is not available.');
    this.name = 'IdentityProviderUnavailableError';
  }
}

/**
 * The configured provider has no identities to authenticate against (e.g.
 * the StaticTokenProvider with no tokens configured). Controlled, loud 503.
 */
class IdentityNotConfiguredError extends IdentityError {
  constructor() {
    super(503, 'identity_not_configured', 'Identity is not configured.');
    this.name = 'IdentityNotConfiguredError';
  }
}

/**
 * A provider returned something that is not a valid GuideHerdIdentity. A
 * platform defect, never a caller problem: surfaced loudly, details logged
 * server-side only.
 */
class IdentityContractViolationError extends IdentityError {
  constructor() {
    super(500, 'identity_contract_violation', 'The identity provider returned an invalid identity.');
    this.name = 'IdentityContractViolationError';
  }
}

module.exports = {
  IdentityError,
  UnauthenticatedError,
  InvalidCredentialsError,
  InsufficientRoleError,
  IdentityProviderUnavailableError,
  IdentityNotConfiguredError,
  IdentityContractViolationError,
};
