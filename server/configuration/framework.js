'use strict';

/**
 * The GuideHerd Customer Configuration Framework (ADR-0016).
 *
 * NOT a settings page: the permanent contract for customer-owned
 * configuration. Producers (the Administration Framework today; imports,
 * installers, APIs, automation tomorrow) submit INTENT; this framework
 * owns correctness. Consumers receive NORMALIZED configuration only and
 * never parse or validate raw documents themselves.
 *
 * ── The domain contract ────────────────────────────────────────────────────
 * Every settings-backed configuration domain registers exactly once:
 *
 *   {
 *     id,               stable domain id (doubles as its administration area)
 *     title,            human name (clients/documentation)
 *     owner,            the subsystem whose validator this is — ownership
 *                       stays with the consumer; the registry only composes
 *     namespace, key,   Configuration Store setting address
 *     live: true,       every settings domain is LIVE (read per request)
 *     schemaVersion,    current document schema version
 *     migrate?,         (doc) -> doc: bring any historical shape to the
 *                       current schema; idempotent; applied on READ (non-
 *                       destructive) and before WRITE validation
 *     normalize,        (raw, context) -> { value, issues } — LENIENT:
 *                       always yields a usable value (defaults applied,
 *                       malformed fields degraded WITHIN the domain, each
 *                       degradation reported as an issue)
 *     validate?,        (doc, context) -> issues[] — additional STRICT
 *                       write-time rules (e.g. cross-checks against the
 *                       deployment, like registered provider keys)
 *   }
 *
 * READ (consumers):  raw setting -> migrate -> normalize -> value.
 *   Fail-safe by construction: a malformed document degrades only inside
 *   its own domain and every other domain is untouched.
 * VALIDATE (producers): migrate -> normalize -> REQUIRE zero issues ->
 *   strict rules -> canonical normalized document. A producer persists
 *   ONLY the canonical result — so nothing partially invalid is ever
 *   written, no matter which producer submitted it, and every producer
 *   goes through the same gate.
 *
 * Unknown domains fail loudly in both directions. Extending the platform
 * with a new configuration domain is ONE registration: the consumer reads
 * through readDomain and the Administration Framework generates its
 * change area from this registry — Core does not change.
 *
 * Entity/catalog configuration (organization, attorneys, practice areas,
 * consultation types, routing, locations/hours) is store-backed: its
 * schema and validation live in the Configuration Store's own normalizers
 * (ADR-0004) and are administered through ADR-0015's entity areas. This
 * registry covers DOCUMENT domains; both families are catalogued in
 * ADR-0016's domain model.
 */

const { ConfigError } = require('../config/errors');

class UnknownConfigurationDomainError extends ConfigError {
  constructor() {
    super(400, 'unknown_configuration_domain', 'The requested configuration domain is not registered.');
    this.name = 'UnknownConfigurationDomainError';
  }
}

function createConfigurationFramework() {
  /** @type {Map<string, object>} */
  const domains = new Map();

  function requireDomain(id) {
    const domain = domains.get(id);
    if (!domain) throw new UnknownConfigurationDomainError();
    return domain;
  }

  const api = {
    /** Register one configuration domain. Duplicate ids fail loudly. */
    register(domain) {
      if (!domain || typeof domain.id !== 'string' || domain.id === ''
        || typeof domain.namespace !== 'string' || typeof domain.key !== 'string'
        || typeof domain.normalize !== 'function') {
        throw new TypeError('A configuration domain must declare id, namespace, key, and normalize().');
      }
      if (domains.has(domain.id)) {
        throw new TypeError(`Configuration domain already registered: ${domain.id}`);
      }
      for (const existing of domains.values()) {
        if (existing.namespace === domain.namespace && existing.key === domain.key) {
          throw new TypeError(`Setting address already owned by domain "${existing.id}": ${domain.namespace}/${domain.key}`);
        }
      }
      domains.set(domain.id, {
        live: true,
        schemaVersion: 1,
        owner: 'platform',
        title: domain.id,
        ...domain,
      });
      return domain;
    },

    /** Registered domain descriptors (documentation, admin generation). */
    descriptors() {
      return [...domains.values()].map(({ id, title, owner, namespace, key, live, schemaVersion }) => ({
        id, title, owner, namespace, key, live, schemaVersion,
      }));
    },

    /**
     * CONSUMER read: the normalized, defaulted, migrated value. Never
     * throws for malformed content — degradation stays in-domain and is
     * reported via issues.
     * @returns {{ value: any, issues: string[] }}
     */
    read(configService, id, organizationKey) {
      const domain = requireDomain(id);
      let raw = null;
      if (configService && organizationKey) {
        try {
          const setting = configService.settings.get(organizationKey, domain.namespace, domain.key);
          raw = setting ? setting.value : null;
        } catch {
          raw = null; // unknown organization / unset — defaults apply
        }
      }
      const migrated = raw !== null && domain.migrate ? domain.migrate(raw) : raw;
      const context = { configService, organizationKey };
      return domain.normalize(migrated, context);
    },

    /**
     * PRODUCER gate: strict validation to the canonical document. Every
     * producer must persist ONLY the returned `normalized` value.
     * @returns {{ ok: boolean, issues: string[], normalized: any }}
     */
    validate(id, document, context = {}) {
      const domain = requireDomain(id);
      const migrated = document !== null && document !== undefined && domain.migrate
        ? domain.migrate(document)
        : document;
      const { value, issues } = domain.normalize(migrated ?? null, context);
      const strictIssues = [...issues];
      if (domain.validate) strictIssues.push(...(domain.validate(value, context) || []));
      return { ok: strictIssues.length === 0, issues: strictIssues, normalized: value };
    },

    /** The setting address of a domain (producers persist canonically). */
    addressOf(id) {
      const { namespace, key } = requireDomain(id);
      return { namespace, key };
    },

    /**
     * IMPORT gate: strict validation of every STORED domain document for
     * one organization — the same producer gate the Administration
     * Framework runs, applied after a seed/import wrote settings through
     * the generic store layer (which by design knows nothing of domains).
     * Unset domains are skipped (defaults are always valid); a stored
     * document with issues is reported so the importer can FAIL rather
     * than boot with silently-degraded configuration.
     * @returns {Array<{ domain: string, issues: string[] }>}
     */
    validateStored(configService, organizationKey, context = {}) {
      const problems = [];
      for (const domain of domains.values()) {
        let raw = null;
        try {
          const setting = configService.settings.get(organizationKey, domain.namespace, domain.key);
          raw = setting ? setting.value : null;
        } catch {
          raw = null;
        }
        if (raw === null) continue;
        const { ok, issues } = api.validate(domain.id, raw, { configService, organizationKey, ...context });
        if (!ok) problems.push({ domain: domain.id, issues });
      }
      return problems;
    },
  };
  return api;
}

// ── The platform's default registry ─────────────────────────────────────────
// Production domains register in configuration/domains.js. The require is
// LAZY (inside the accessor) so subsystem validators can delegate their
// resolvers here without import cycles: by the time any read happens, all
// modules are fully loaded.
const defaultFramework = createConfigurationFramework();
let productionDomainsLoaded = false;
function withProductionDomains() {
  if (!productionDomainsLoaded) {
    productionDomainsLoaded = true;
    require('./domains').registerProductionDomains(defaultFramework);
  }
  return defaultFramework;
}

/** Consumer read against the default registry. */
function readDomain(configService, id, organizationKey) {
  return withProductionDomains().read(configService, id, organizationKey);
}

/** Producer validation against the default registry. */
function validateDomain(id, document, context = {}) {
  return withProductionDomains().validate(id, document, context);
}

function domainDescriptors() {
  return withProductionDomains().descriptors();
}

function domainAddress(id) {
  return withProductionDomains().addressOf(id);
}

/** Import gate against the default registry (seed/import validation). */
function validateStoredDomainSettings(configService, organizationKey, context = {}) {
  return withProductionDomains().validateStored(configService, organizationKey, context);
}

module.exports = {
  createConfigurationFramework,
  readDomain,
  validateDomain,
  domainDescriptors,
  domainAddress,
  validateStoredDomainSettings,
  UnknownConfigurationDomainError,
};
