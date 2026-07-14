'use strict';

/**
 * Domain errors for the Configuration Store.
 *
 * Errors carry an HTTP-shaped status and a stable machine-readable code so a
 * future API layer can map them directly, but nothing in this module assumes
 * an HTTP transport. Messages are generic and MUST NOT echo raw input values.
 */
class ConfigError extends Error {
  /**
   * @param {number} status HTTP-shaped status code
   * @param {string} code stable error code
   * @param {string} message safe, generic description
   * @param {Array<{field: string, message: string}>} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ConfigError';
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

class ValidationError extends ConfigError {
  constructor(message, details) {
    super(400, 'validation_error', message, details);
    this.name = 'ValidationError';
  }
}

/**
 * A referenced entity does not exist. The entity name is embedded in the
 * error code (e.g. `unknown_organization`, `unknown_provider`) so callers
 * can distinguish which lookup failed without parsing messages.
 */
class UnknownEntityError extends ConfigError {
  /** @param {string} entity singular snake_case entity name */
  constructor(entity) {
    const label = entity.replace(/_/g, ' ');
    super(404, `unknown_${entity}`, `The ${label} is not recognized.`);
    this.name = 'UnknownEntityError';
    this.entity = entity;
  }
}

/** A create/update collided with an existing key in the same scope. */
class DuplicateKeyError extends ConfigError {
  /** @param {string} entity singular snake_case entity name */
  constructor(entity) {
    const label = entity.replace(/_/g, ' ');
    super(409, 'duplicate_key', `A ${label} with this key already exists.`);
    this.name = 'DuplicateKeyError';
    this.entity = entity;
  }
}

/** A schema migration failed and was rolled back. */
class MigrationError extends ConfigError {
  /** @param {string} version migration version that failed */
  constructor(version, cause) {
    super(500, 'migration_failed', `Migration ${version} failed and was rolled back.`);
    this.name = 'MigrationError';
    this.version = version;
    if (cause) this.cause = cause;
  }
}

module.exports = {
  ConfigError,
  ValidationError,
  UnknownEntityError,
  DuplicateKeyError,
  MigrationError,
};
