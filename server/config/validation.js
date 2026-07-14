'use strict';

const { ValidationError } = require('./errors');
const { KEY_PATTERN, TIME_PATTERN, LIMITS } = require('./models');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A collector of field problems, mirroring handoff/validation.js: every
 * normalize* function validates the whole input, gathers all problems, and
 * throws a single ValidationError listing them.
 */
function collector() {
  const details = [];

  /** Validate one ordinary string field; returns trimmed value or undefined. */
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

  /** Validate a stable identifier (kebab-case key). */
  function key(value, field, required = true) {
    const trimmed = str(value, field, required, LIMITS.key);
    if (trimmed === undefined) return undefined;
    if (!KEY_PATTERN.test(trimmed)) {
      details.push({ field, message: 'must be kebab-case (lowercase letters, digits, hyphens)' });
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

  function int(value, field, { min, max } = {}) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      details.push({ field, message: 'must be an integer' });
      return undefined;
    }
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      details.push({ field, message: `must be between ${min} and ${max}` });
      return undefined;
    }
    return value;
  }

  /** Optional, permissive email (x@y.tld shape); same posture as handoff. */
  function email(value, field) {
    const trimmed = str(value, field, false, LIMITS.email);
    if (trimmed === undefined) return undefined;
    const at = trimmed.lastIndexOf('@');
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    if (at < 1 || local === '' || !/^[^\s@]+\.[^\s@]+$/.test(domain) || /\s/.test(trimmed)) {
      details.push({ field, message: 'must be a valid email address' });
      return undefined;
    }
    return local + '@' + domain.toLowerCase();
  }

  /** HH:MM 24-hour time. */
  function time(value, field, required) {
    const trimmed = str(value, field, required, 5);
    if (trimmed === undefined) return undefined;
    if (!TIME_PATTERN.test(trimmed)) {
      details.push({ field, message: 'must be a time in HH:MM 24-hour format' });
      return undefined;
    }
    return trimmed;
  }

  function requireObject(body, label) {
    if (!isPlainObject(body)) {
      throw new ValidationError(`${label} must be a JSON object.`, [
        { field: '(body)', message: 'must be a JSON object' },
      ]);
    }
  }

  function throwIfInvalid() {
    if (details.length > 0) {
      throw new ValidationError('One or more fields are invalid.', details);
    }
  }

  return { details, str, key, bool, int, email, time, requireObject, throwIfInvalid };
}

/** Drop properties whose value is undefined (omitted optionals). */
function compact(obj) {
  for (const prop of Object.keys(obj)) {
    if (obj[prop] === undefined) delete obj[prop];
  }
  return obj;
}

// ── Organizations ────────────────────────────────────────────────────────────

/** @returns {{key: string, name: string, displayName?: string, timezone: string, active: boolean}} */
function normalizeOrganization(body) {
  const v = collector();
  v.requireObject(body, 'Organization');
  const normalized = {
    key: v.key(body.key, 'key'),
    name: v.str(body.name, 'name', true, LIMITS.name),
    displayName: v.str(body.displayName, 'displayName', false, LIMITS.displayName),
    timezone: v.str(body.timezone, 'timezone', false, LIMITS.timezone),
    active: v.bool(body.active, 'active'),
  };
  v.throwIfInvalid();
  if (normalized.timezone === undefined) normalized.timezone = 'UTC';
  if (normalized.active === undefined) normalized.active = true;
  return compact(normalized);
}

// ── Locations & office hours ─────────────────────────────────────────────────

/** @returns {import('./models').OfficeHour[]} */
function normalizeOfficeHours(hours, fieldPrefix = 'officeHours') {
  if (!Array.isArray(hours)) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: fieldPrefix, message: 'must be an array' },
    ]);
  }
  const v = collector();
  const normalized = hours.map((entry, i) => {
    const field = `${fieldPrefix}[${i}]`;
    if (!isPlainObject(entry)) {
      v.details.push({ field, message: 'must be an object' });
      return undefined;
    }
    let dayOfWeek;
    if (entry.dayOfWeek === undefined || entry.dayOfWeek === null) {
      v.details.push({ field: `${field}.dayOfWeek`, message: 'is required' });
    } else {
      dayOfWeek = v.int(entry.dayOfWeek, `${field}.dayOfWeek`, { min: 0, max: 6 });
    }
    const hour = {
      dayOfWeek,
      opens: v.time(entry.opens, `${field}.opens`, true),
      closes: v.time(entry.closes, `${field}.closes`, true),
    };
    if (hour.opens !== undefined && hour.closes !== undefined && hour.closes <= hour.opens) {
      v.details.push({ field: `${field}.closes`, message: 'must be later than opens' });
    }
    return hour;
  });
  v.throwIfInvalid();
  return normalized;
}

/** @returns {import('./models').Location} */
function normalizeLocation(body) {
  const v = collector();
  v.requireObject(body, 'Location');
  const normalized = {
    key: v.key(body.key, 'key'),
    name: v.str(body.name, 'name', true, LIMITS.name),
    addressLine1: v.str(body.addressLine1, 'addressLine1', false, LIMITS.addressLine),
    addressLine2: v.str(body.addressLine2, 'addressLine2', false, LIMITS.addressLine),
    city: v.str(body.city, 'city', false, LIMITS.city),
    region: v.str(body.region, 'region', false, LIMITS.region),
    postalCode: v.str(body.postalCode, 'postalCode', false, LIMITS.postalCode),
    phone: v.str(body.phone, 'phone', false, LIMITS.phone),
    active: v.bool(body.active, 'active'),
  };
  v.throwIfInvalid();
  if (normalized.active === undefined) normalized.active = true;
  const result = compact(normalized);
  if (body.officeHours !== undefined) {
    result.officeHours = normalizeOfficeHours(body.officeHours);
  }
  return result;
}

// ── Providers ────────────────────────────────────────────────────────────────

/** @returns {import('./models').Provider} */
function normalizeProvider(body) {
  const v = collector();
  v.requireObject(body, 'Provider');
  const normalized = {
    key: v.key(body.key, 'key'),
    name: v.str(body.name, 'name', true, LIMITS.name),
    displayName: v.str(body.displayName, 'displayName', false, LIMITS.displayName),
    email: v.email(body.email, 'email'),
    phone: v.str(body.phone, 'phone', false, LIMITS.phone),
    active: v.bool(body.active, 'active'),
  };
  v.throwIfInvalid();
  if (normalized.active === undefined) normalized.active = true;
  return compact(normalized);
}

// ── Catalog items (service areas, consultation types) ───────────────────────

/** @returns {import('./models').CatalogItem} */
function normalizeCatalogItem(body) {
  const v = collector();
  v.requireObject(body, 'Catalog item');
  const normalized = {
    key: v.key(body.key, 'key'),
    name: v.str(body.name, 'name', true, LIMITS.name),
    displayOrder: v.int(body.displayOrder, 'displayOrder', { min: 0, max: 100000 }),
    active: v.bool(body.active, 'active'),
  };
  v.throwIfInvalid();
  if (normalized.displayOrder === undefined) normalized.displayOrder = 0;
  if (normalized.active === undefined) normalized.active = true;
  return compact(normalized);
}

// ── Routing groups ───────────────────────────────────────────────────────────

/** @returns {{key: string, name: string, serviceArea: string, active: boolean, providers?: string[]}} */
function normalizeRoutingGroup(body) {
  const v = collector();
  v.requireObject(body, 'Routing group');
  const normalized = {
    key: v.key(body.key, 'key'),
    name: v.str(body.name, 'name', true, LIMITS.name),
    serviceArea: v.key(body.serviceArea, 'serviceArea'),
    active: v.bool(body.active, 'active'),
  };
  if (body.providers !== undefined) {
    if (!Array.isArray(body.providers)) {
      v.details.push({ field: 'providers', message: 'must be an array of provider keys' });
    } else {
      normalized.providers = body.providers.map((p, i) => v.key(p, `providers[${i}]`));
    }
  }
  v.throwIfInvalid();
  if (normalized.active === undefined) normalized.active = true;
  return compact(normalized);
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** @returns {{namespace: string, key: string, valueJson: string}} */
function normalizeSetting(namespace, key, value) {
  const v = collector();
  const normalized = {
    namespace: v.key(namespace, 'namespace'),
    key: v.key(key, 'key'),
  };
  if (normalized.namespace !== undefined && normalized.namespace.length > LIMITS.namespace) {
    v.details.push({ field: 'namespace', message: `must be at most ${LIMITS.namespace} characters` });
  }
  let valueJson;
  if (value === undefined) {
    v.details.push({ field: 'value', message: 'is required' });
  } else {
    try {
      valueJson = JSON.stringify(value);
    } catch (err) {
      valueJson = undefined;
    }
    if (typeof valueJson !== 'string') {
      v.details.push({ field: 'value', message: 'must be JSON-serializable' });
    } else if (valueJson.length > LIMITS.settingValue) {
      v.details.push({ field: 'value', message: `must serialize to at most ${LIMITS.settingValue} characters` });
    }
  }
  v.throwIfInvalid();
  normalized.valueJson = valueJson;
  return normalized;
}

// ── Update patches ───────────────────────────────────────────────────────────

/**
 * Validate a partial update. Only fields present in `body` are validated and
 * returned. `key` is immutable and rejected if present. `allowed` names the
 * updatable fields for the entity; each is validated with the same rule as
 * its create counterpart.
 *
 * @param {unknown} body
 * @param {string[]} allowed
 * @returns {Object} normalized sparse patch
 */
function normalizePatch(body, allowed) {
  const v = collector();
  v.requireObject(body, 'Patch');
  if ('key' in body) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'key', message: 'is immutable' },
    ]);
  }
  const rules = {
    name: (val) => v.str(val, 'name', true, LIMITS.name),
    displayName: (val) => v.str(val, 'displayName', false, LIMITS.displayName),
    timezone: (val) => v.str(val, 'timezone', true, LIMITS.timezone),
    email: (val) => v.email(val, 'email'),
    phone: (val) => v.str(val, 'phone', false, LIMITS.phone),
    addressLine1: (val) => v.str(val, 'addressLine1', false, LIMITS.addressLine),
    addressLine2: (val) => v.str(val, 'addressLine2', false, LIMITS.addressLine),
    city: (val) => v.str(val, 'city', false, LIMITS.city),
    region: (val) => v.str(val, 'region', false, LIMITS.region),
    postalCode: (val) => v.str(val, 'postalCode', false, LIMITS.postalCode),
    displayOrder: (val) => v.int(val, 'displayOrder', { min: 0, max: 100000 }),
    serviceArea: (val) => v.key(val, 'serviceArea'),
    active: (val) => v.bool(val, 'active'),
  };

  const patch = {};
  const unknown = [];
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field) || !rules[field]) {
      unknown.push({ field, message: 'is not an updatable field' });
      continue;
    }
    patch[field] = rules[field](body[field]);
  }
  v.details.push(...unknown);
  v.throwIfInvalid();

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: '(body)', message: 'must contain at least one updatable field' },
    ]);
  }
  return compact(patch);
}

module.exports = {
  normalizeOrganization,
  normalizeLocation,
  normalizeOfficeHours,
  normalizeProvider,
  normalizeCatalogItem,
  normalizeRoutingGroup,
  normalizeSetting,
  normalizePatch,
};
