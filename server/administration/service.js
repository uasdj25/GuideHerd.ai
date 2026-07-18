'use strict';

/**
 * The GuideHerd Administration Framework (ADR-0015).
 *
 * NOT a portal: the permanent framework through which configuration is
 * administered. Clients (the web portal today; CLI, import/export, or a
 * future API tomorrow) submit CHANGE REQUESTS; GuideHerd validates,
 * persists through the Configuration Store, versions, and audits. No
 * consumer knows or cares whether configuration arrived from a git seed,
 * this framework, or anything else — administration is one PRODUCER over
 * the same store every subsystem already consumes, which is exactly why
 * changes take effect live: consumers read configuration per request.
 *
 * ── Change areas (typed dispatch; unknown areas fail loudly) ───────────────
 * organization · practice-areas · attorneys · attorney-order ·
 * scheduling-policy · notification-branding · notifications · office ·
 * business-hours · identity-provider
 *
 * ── Validation ownership ───────────────────────────────────────────────────
 * Owned by the consuming subsystem wherever it exists and delegated to it:
 * catalog/entity rules by the Configuration Store's own normalizers;
 * scheduling policy by the Scheduling Policy Engine's normalizePolicy
 * (a document it would even partially reject at runtime is refused here
 * outright — administration is stricter than runtime fail-safety);
 * office hours by the store's normalizeOfficeHours; identity provider
 * keys against the registered provider registry. Only where no consumer
 * validator exists yet (notification branding shape) does this module
 * validate directly, mirroring the consumer's documented constraints.
 * Nothing partially-invalid is ever written: every apply runs inside one
 * Configuration Store transaction with its audit row.
 *
 * ── Versioning and optimistic concurrency ──────────────────────────────────
 * Every change writes a configuration_audit row with a monotonic version
 * per (organization, entity) plus before/after snapshots. Writers name
 * the `expectedVersion` they read; a mismatch is an explicit 409 —
 * concurrent administrators can never silently overwrite each other.
 * The snapshots are the foundation for future rollback (deliberately no
 * rollback UI here).
 */

const { ConfigError, ValidationError } = require('../config/errors');
const { normalizePolicy, SETTINGS_NAMESPACE: SCHEDULING_NS, POLICY_KEY } = require('../scheduling/policy');

/** A concurrent administrator changed this entity since it was read. */
class ConfigurationConflictError extends ConfigError {
  constructor() {
    super(409, 'configuration_version_conflict', 'The configuration was changed by someone else. Reload and retry.');
    this.name = 'ConfigurationConflictError';
  }
}

class UnknownAdministrationAreaError extends ConfigError {
  constructor() {
    super(400, 'unknown_administration_area', 'The requested configuration area is not administrable.');
    this.name = 'UnknownAdministrationAreaError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate a notification-branding document (mirrors branding.js rules). */
function validateBranding(branding) {
  if (!isPlainObject(branding)) throw new ValidationError('Branding must be an object.', [{ field: 'branding', message: 'must be an object' }]);
  const details = [];
  const allowed = ['senderName', 'accentColor', 'logoUrl', 'footerText', 'office'];
  for (const key of Object.keys(branding)) {
    if (!allowed.includes(key)) details.push({ field: `branding.${key}`, message: 'is not a branding field' });
  }
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  if (branding.senderName !== undefined && (!str(branding.senderName) || branding.senderName.length > 200)) {
    details.push({ field: 'branding.senderName', message: 'must be a nonblank string of at most 200 characters' });
  }
  if (branding.accentColor !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(String(branding.accentColor))) {
    details.push({ field: 'branding.accentColor', message: 'must be a hex color' });
  }
  if (branding.logoUrl !== undefined && !(str(branding.logoUrl) && branding.logoUrl.startsWith('https://') && branding.logoUrl.length <= 500)) {
    details.push({ field: 'branding.logoUrl', message: 'must be an https URL' });
  }
  if (branding.footerText !== undefined && (!str(branding.footerText) || branding.footerText.length > 500)) {
    details.push({ field: 'branding.footerText', message: 'must be a nonblank string of at most 500 characters' });
  }
  if (branding.office !== undefined) {
    if (!isPlainObject(branding.office)) {
      details.push({ field: 'branding.office', message: 'must be an object' });
    } else {
      for (const key of Object.keys(branding.office)) {
        if (!['phone', 'email', 'address'].includes(key)) details.push({ field: `branding.office.${key}`, message: 'is not an office field' });
      }
    }
  }
  if (details.length > 0) throw new ValidationError('One or more branding fields are invalid.', details);
}

/**
 * @param {{
 *   configService: object,
 *   configDb: object,                      the Configuration Store database
 *   clock: import('../handoff/clock').Clock,
 *   identityProviderKeys?: () => string[], registered identity providers
 *   telemetry?: { event: Function },
 * }} deps
 */
function createAdministrationService({ configService, configDb, clock, identityProviderKeys = () => [], telemetry }) {
  const nowIso = () => new Date(clock.now()).toISOString();
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  const stmt = {
    currentVersion: configDb.prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM configuration_audit WHERE organization_key = ? AND entity = ?',
    ),
    insert: configDb.prepare(
      `INSERT INTO configuration_audit (organization_key, entity, action, actor, version, before_json, after_json, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    list: configDb.prepare(
      `SELECT entity, action, actor, version, before_json, after_json, at
         FROM configuration_audit WHERE organization_key = ? ORDER BY id DESC LIMIT ?`,
    ),
    listForEntity: configDb.prepare(
      `SELECT entity, action, actor, version, before_json, after_json, at
         FROM configuration_audit WHERE organization_key = ? AND entity = ? ORDER BY version DESC LIMIT ?`,
    ),
  };

  function currentVersion(organizationKey, entity) {
    return stmt.currentVersion.get(organizationKey, entity).v;
  }

  /**
   * Run one administered change atomically: optimistic-concurrency check,
   * the change itself, and the audit row — one transaction. Returns the
   * new entity version alongside the change's result.
   */
  function administer({ actor, organizationKey, entity, action, expectedVersion, before, change }) {
    let result;
    let version;
    // One atomic unit via the Configuration Store's re-entrant
    // transaction: the concurrency check, the change (which may transact
    // internally), and the audit row commit or roll back together.
    configService.transaction(() => {
      version = currentVersion(organizationKey, entity);
      if (expectedVersion !== undefined && expectedVersion !== version) {
        throw new ConfigurationConflictError();
      }
      result = change();
      stmt.insert.run(
        organizationKey, entity, action, actor, version + 1,
        before === undefined ? null : JSON.stringify(before),
        result === undefined ? null : JSON.stringify(result),
        nowIso(),
      );
    });
    emit('configuration.changed', {
      severity: 'info',
      component: 'configuration-store',
      operation: action,
      organizationKey,
      subject: actor,
      code: entity,
    });
    return { result, version: version + 1 };
  }

  /** Read a setting value (or null) without throwing on absence. */
  function settingValue(organizationKey, namespace, key) {
    try {
      const setting = configService.settings.get(organizationKey, namespace, key);
      return setting ? setting.value : null;
    } catch {
      return null;
    }
  }

  const settingArea = (namespace, key, entityName, validate) => ({
    read: (org) => settingValue(org, namespace, key),
    apply: (ctx, payload) => {
      validate(ctx.organizationKey, payload);
      return administer({
        ...ctx,
        entity: entityName,
        action: 'update',
        before: settingValue(ctx.organizationKey, namespace, key),
        change: () => {
          configService.settings.set(ctx.organizationKey, namespace, key, payload);
          return payload;
        },
      });
    },
  });

  /** The administrable areas. Unknown areas fail loudly. */
  const areas = {
    organization: {
      apply: (ctx, payload) => {
        if (!isPlainObject(payload)) throw new ValidationError('Organization patch must be an object.', []);
        return administer({
          ...ctx,
          entity: 'organization',
          action: 'update',
          before: configService.organizations.get(ctx.organizationKey),
          // The store's own normalizePatch validates fields; unknown or
          // invalid fields fail there and nothing is written.
          change: () => configService.organizations.update(ctx.organizationKey, payload),
        });
      },
    },

    'practice-areas': {
      apply: (ctx, payload) => {
        const { action, key, fields } = payload || {};
        if (action === 'create') {
          return administer({
            ...ctx, entity: 'practice-areas', action: 'create',
            change: () => configService.serviceAreas.create(ctx.organizationKey, fields),
          });
        }
        if (action === 'update' && typeof key === 'string') {
          return administer({
            ...ctx, entity: `practice-area:${key}`, action: 'update',
            before: configService.serviceAreas.get(ctx.organizationKey, key),
            change: () => configService.serviceAreas.update(ctx.organizationKey, key, fields),
          });
        }
        throw new ValidationError('practice-areas requires action create|update.', []);
      },
    },

    attorneys: {
      apply: (ctx, payload) => {
        const { action, key, fields } = payload || {};
        if (action === 'create') {
          return administer({
            ...ctx, entity: 'attorneys', action: 'create',
            change: () => configService.providers.create(ctx.organizationKey, fields),
          });
        }
        if (action === 'update' && typeof key === 'string') {
          return administer({
            ...ctx, entity: `attorney:${key}`, action: 'update',
            before: configService.providers.get(ctx.organizationKey, key),
            change: () => configService.providers.update(ctx.organizationKey, key, fields),
          });
        }
        throw new ValidationError('attorneys requires action create|update.', []);
      },
    },

    // Attorney ordering: the ordered member list of a routing group is the
    // order the Console (and future engines) present attorneys in.
    'attorney-order': {
      apply: (ctx, payload) => {
        const { groupKey, attorneys } = payload || {};
        if (typeof groupKey !== 'string' || !Array.isArray(attorneys) || attorneys.length === 0
          || !attorneys.every((a) => typeof a === 'string' && a.trim() !== '')) {
          throw new ValidationError('attorney-order requires groupKey and a nonempty ordered attorneys list.', []);
        }
        return administer({
          ...ctx, entity: `routing-group:${groupKey}`, action: 'reorder',
          before: configService.routingGroups.get(ctx.organizationKey, groupKey),
          change: () => configService.routingGroups.setProviders(ctx.organizationKey, groupKey, attorneys),
        });
      },
    },

    // Scheduling policy: validation is OWNED by the Scheduling Policy
    // Engine. A document with any invalid field is refused outright.
    'scheduling-policy': settingArea(SCHEDULING_NS, POLICY_KEY, 'setting:scheduling/policy', (org, payload) => {
      const { policy, issues } = normalizePolicy(payload);
      if (issues.length > 0) {
        throw new ValidationError('The scheduling policy is invalid.', issues.map((message) => ({ field: 'policy', message })));
      }
      if (payload !== null && policy === null) {
        throw new ValidationError('The scheduling policy has no valid fields.', []);
      }
    }),

    'notification-branding': settingArea('notifications', 'branding', 'setting:notifications/branding', (org, payload) => {
      validateBranding(payload);
    }),

    notifications: settingArea('notifications', 'appointment-confirmation', 'setting:notifications/appointment-confirmation', (org, payload) => {
      if (!isPlainObject(payload) || typeof payload.enabled !== 'boolean'
        || Object.keys(payload).length !== 1) {
        throw new ValidationError('notifications requires { enabled: boolean }.', []);
      }
    }),

    office: {
      apply: (ctx, payload) => {
        const { locationKey, action, fields } = payload || {};
        if (action === 'create') {
          return administer({
            ...ctx, entity: 'locations', action: 'create',
            change: () => configService.locations.create(ctx.organizationKey, fields),
          });
        }
        if (action === 'update' && typeof locationKey === 'string') {
          return administer({
            ...ctx, entity: `location:${locationKey}`, action: 'update',
            before: configService.locations.get(ctx.organizationKey, locationKey),
            change: () => configService.locations.update(ctx.organizationKey, locationKey, fields),
          });
        }
        throw new ValidationError('office requires action create|update.', []);
      },
    },

    // Business hours: validation owned by the Configuration Store's
    // normalizeOfficeHours inside setOfficeHours — atomic replacement.
    'business-hours': {
      apply: (ctx, payload) => {
        const { locationKey, officeHours } = payload || {};
        if (typeof locationKey !== 'string') {
          throw new ValidationError('business-hours requires locationKey and officeHours.', []);
        }
        return administer({
          ...ctx, entity: `location:${locationKey}:hours`, action: 'update',
          before: configService.locations.get(ctx.organizationKey, locationKey).officeHours,
          change: () => configService.locations.setOfficeHours(ctx.organizationKey, locationKey, officeHours).officeHours,
        });
      },
    },

    // Identity provider selection: LIVE (resolved per login). The key must
    // name a REGISTERED provider — configuring an unknown provider would
    // break every login for the organization, so it is refused here.
    'identity-provider': settingArea('identity', 'provider', 'setting:identity/provider', (org, payload) => {
      if (!isPlainObject(payload) || typeof payload.provider !== 'string' || Object.keys(payload).length !== 1) {
        throw new ValidationError('identity-provider requires { provider: string }.', []);
      }
      const known = identityProviderKeys();
      if (!known.includes(payload.provider)) {
        throw new ValidationError('The identity provider is not registered on this deployment.', [
          { field: 'provider', message: `must be one of: ${known.join(', ')}` },
        ]);
      }
    }),
  };

  return {
    /** Administrable area names (clients/tests). */
    areaNames: () => Object.keys(areas),

    /**
     * Apply one administered change.
     * @param {string} area an administrable area name
     * @param {{ actor: string, organizationKey: string }} ctx from the
     *        authenticated session — never from client input
     * @param {object} payload area-specific change request
     * @param {number} [expectedVersion] optimistic concurrency token
     */
    apply(area, ctx, payload, expectedVersion) {
      const handler = areas[area];
      if (!handler) throw new UnknownAdministrationAreaError();
      return handler.apply({ ...ctx, expectedVersion }, payload);
    },

    /** The full administered view of one organization, with versions. */
    describe(organizationKey) {
      const versionOf = (entity) => currentVersion(organizationKey, entity);
      return {
        organization: { ...configService.organizations.get(organizationKey), version: versionOf('organization') },
        practiceAreas: configService.serviceAreas.list(organizationKey, {}),
        attorneys: configService.providers.list(organizationKey, {}),
        routingGroups: configService.routingGroups.list(organizationKey, {}),
        locations: configService.locations.list(organizationKey, {}),
        settings: {
          schedulingPolicy: { value: settingValue(organizationKey, SCHEDULING_NS, POLICY_KEY), version: versionOf('setting:scheduling/policy') },
          notificationBranding: { value: settingValue(organizationKey, 'notifications', 'branding'), version: versionOf('setting:notifications/branding') },
          notifications: { value: settingValue(organizationKey, 'notifications', 'appointment-confirmation'), version: versionOf('setting:notifications/appointment-confirmation') },
          identityProvider: { value: settingValue(organizationKey, 'identity', 'provider'), version: versionOf('setting:identity/provider') },
        },
        registeredIdentityProviders: identityProviderKeys(),
      };
    },

    /** Audit history, newest first. */
    audit(organizationKey, { entity, limit = 50 } = {}) {
      const rows = entity
        ? stmt.listForEntity.all(organizationKey, entity, Math.max(1, limit))
        : stmt.list.all(organizationKey, Math.max(1, limit));
      return rows.map((r) => ({
        entity: r.entity,
        action: r.action,
        actor: r.actor,
        version: r.version,
        before: r.before_json === null ? null : JSON.parse(r.before_json),
        after: r.after_json === null ? null : JSON.parse(r.after_json),
        at: r.at,
      }));
    },

    currentVersion,
  };
}

module.exports = { createAdministrationService, ConfigurationConflictError, UnknownAdministrationAreaError };
