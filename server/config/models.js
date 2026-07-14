'use strict';

/**
 * Domain models and limits for the GuideHerd Configuration Store.
 *
 * Naming is deliberately industry-neutral so the schema is reusable beyond
 * the first (legal) vertical. The GuideHerd domain language maps onto these
 * shapes at the presentation layer:
 *
 *   | Neutral term       | Legal vertical    |
 *   |--------------------|-------------------|
 *   | Organization       | Firm              |
 *   | Provider           | Attorney          |
 *   | Service Area       | Practice Area     |
 *   | Consultation Type  | Consultation Type |
 *   | Routing Group      | Scheduling Group  |
 *
 * Every configurable entity has a stable string `key` (kebab-case), unique
 * within its organization. Keys are the identifiers that flow through
 * GuideHerd contracts (e.g. `clay-martinson`, `initial-consultation`);
 * integer row ids never leave the store layer.
 *
 * @typedef {Object} Organization
 * @property {string} key            globally unique, kebab-case
 * @property {string} name
 * @property {string|null} displayName
 * @property {string} timezone       IANA identifier (e.g. America/Chicago)
 * @property {boolean} active
 *
 * @typedef {Object} Location
 * @property {string} key            unique within the organization
 * @property {string} name
 * @property {string|null} addressLine1
 * @property {string|null} addressLine2
 * @property {string|null} city
 * @property {string|null} region
 * @property {string|null} postalCode
 * @property {string|null} phone
 * @property {boolean} active
 * @property {OfficeHour[]} [officeHours]
 *
 * @typedef {Object} OfficeHour
 * @property {number} dayOfWeek      0 (Sunday) through 6 (Saturday)
 * @property {string} opens          HH:MM, 24-hour, location-local time
 * @property {string} closes         HH:MM, 24-hour, location-local time
 *
 * @typedef {Object} Provider
 * @property {string} key            unique within the organization
 * @property {string} name
 * @property {string|null} displayName
 * @property {string|null} email
 * @property {string|null} phone
 * @property {boolean} active
 *
 * Service areas and consultation types share one catalog shape.
 * @typedef {Object} CatalogItem
 * @property {string} key            unique within the organization
 * @property {string} name
 * @property {number} displayOrder
 * @property {boolean} active
 *
 * A routing group is how one service area routes to providers. Several
 * groups may serve the same service area; every group serves exactly one.
 * @typedef {Object} RoutingGroup
 * @property {string} key            unique within the organization
 * @property {string} name
 * @property {string} serviceArea    key of the service area this group serves
 * @property {boolean} active
 * @property {string[]} providers    member provider keys
 *
 * @typedef {Object} Setting
 * @property {string} namespace      kebab-case grouping (e.g. `voice`, `notifications`)
 * @property {string} key            kebab-case, unique within (organization, namespace)
 * @property {*} value               any JSON-serializable value
 */

/**
 * Stable identifier format: kebab-case, starting and ending with an
 * alphanumeric. Matches the ids already used across GuideHerd contracts.
 */
const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** HH:MM, 24-hour. */
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Maximum accepted length per string field. These guard against accidental
 * oversized payloads; they are not business rules.
 */
const LIMITS = Object.freeze({
  key: 128,
  name: 200,
  displayName: 200,
  timezone: 64,
  addressLine: 200,
  city: 100,
  region: 100,
  postalCode: 20,
  phone: 40,
  email: 254,
  namespace: 64,
  /** Serialized JSON length for one setting value. */
  settingValue: 16384,
});

module.exports = { KEY_PATTERN, TIME_PATTERN, LIMITS };
