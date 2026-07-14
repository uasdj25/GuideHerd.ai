'use strict';

const { ValidationError } = require('./errors');
const { LIMITS } = require('./models');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate and normalize a create-handoff request body.
 * Trims ordinary string fields, enforces required/blank/length rules, and
 * collects all problems into a single ValidationError.
 *
 * @param {unknown} body
 * @returns {import('./models').CreateHandoffRequest}
 */
function normalizeCreate(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('Request body must be a JSON object.', [
      { field: '(body)', message: 'must be a JSON object' },
    ]);
  }

  const details = [];
  const caller = isPlainObject(body.caller) ? body.caller : {};
  const scheduling = isPlainObject(body.scheduling) ? body.scheduling : {};
  const handoff = isPlainObject(body.handoff) ? body.handoff : {};

  /**
   * Validate a required email. Trims whitespace, preserves the local part
   * exactly, lowercases only the domain. Deliberately permissive format
   * check (x@y.tld shape) so legitimate addresses are never rejected.
   */
  function email(value, field, max) {
    if (value === undefined || value === null) {
      details.push({ field, message: 'is required' });
      return undefined;
    }
    if (typeof value !== 'string') {
      details.push({ field, message: 'must be a string' });
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      details.push({ field, message: 'must not be blank' });
      return undefined;
    }
    if (trimmed.length > max) {
      details.push({ field, message: `must be at most ${max} characters` });
      return undefined;
    }
    const at = trimmed.lastIndexOf('@');
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    if (at < 1 || local === '' || !/^[^\s@]+\.[^\s@]+$/.test(domain) || /\s/.test(trimmed)) {
      details.push({ field, message: 'must be a valid email address' });
      return undefined;
    }
    return local + '@' + domain.toLowerCase();
  }

  /** Validate one string field; returns the trimmed value or undefined. */
  function str(value, field, required, max) {
    if (value === undefined || value === null) {
      if (required) details.push({ field, message: 'is required' });
      return undefined;
    }
    if (typeof value !== 'string') {
      details.push({ field, message: 'must be a string' });
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      if (required) details.push({ field, message: 'must not be blank' });
      return undefined;
    }
    if (trimmed.length > max) {
      details.push({ field, message: `must be at most ${max} characters` });
      return undefined;
    }
    return trimmed;
  }

  function bool(value, field) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
      details.push({ field, message: 'must be a boolean' });
      return undefined;
    }
    return value;
  }

  const normalized = {
    firmId: str(body.firmId, 'firmId', true, LIMITS.firmId),
    caller: {
      fullName: str(caller.fullName, 'caller.fullName', true, LIMITS.fullName),
      email: email(caller.email, 'caller.email', LIMITS.email),
      phone: str(caller.phone, 'caller.phone', false, LIMITS.phone),
    },
    scheduling: {
      attorneyId: str(scheduling.attorneyId, 'scheduling.attorneyId', true, LIMITS.attorneyId),
      practiceAreaId: str(scheduling.practiceAreaId, 'scheduling.practiceAreaId', false, LIMITS.practiceAreaId),
      consultationTypeId: str(scheduling.consultationTypeId, 'scheduling.consultationTypeId', true, LIMITS.consultationTypeId),
      existingClient: bool(scheduling.existingClient, 'scheduling.existingClient'),
    },
    handoff: {
      createdByUserId: str(handoff.createdByUserId, 'handoff.createdByUserId', false, LIMITS.createdByUserId),
      source: str(handoff.source, 'handoff.source', true, LIMITS.source),
      mode: str(handoff.mode, 'handoff.mode', true, LIMITS.mode),
    },
  };

  if (details.length > 0) {
    throw new ValidationError('One or more fields are invalid.', details);
  }

  // Drop optional fields that were omitted, and default existingClient.
  if (normalized.caller.phone === undefined) delete normalized.caller.phone;
  if (normalized.scheduling.practiceAreaId === undefined) delete normalized.scheduling.practiceAreaId;
  if (normalized.handoff.createdByUserId === undefined) delete normalized.handoff.createdByUserId;
  if (normalized.scheduling.existingClient === undefined) normalized.scheduling.existingClient = false;

  return normalized;
}

/**
 * Validate a redeem request body.
 * @param {unknown} body
 * @returns {{ handoffToken: string }}
 */
function normalizeRedeem(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('Request body must be a JSON object.', [
      { field: '(body)', message: 'must be a JSON object' },
    ]);
  }
  const value = body.handoffToken;
  if (value === undefined || value === null) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'handoffToken', message: 'is required' },
    ]);
  }
  if (typeof value !== 'string') {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'handoffToken', message: 'must be a string' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'handoffToken', message: 'must not be blank' },
    ]);
  }
  if (trimmed.length > LIMITS.token) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'handoffToken', message: `must be at most ${LIMITS.token} characters` },
    ]);
  }
  return { handoffToken: trimmed };
}

module.exports = { normalizeCreate, normalizeRedeem };
