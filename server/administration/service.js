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
 * organization · practice-areas · attorneys · consultation-types ·
 * routing-groups · attorney-order · office · business-hours · users (#65) ·
 * every registered configuration domain (scheduling-policy,
 * notification-branding, notifications, identity-provider, …)
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

const crypto = require('node:crypto');

const { ConfigError, ValidationError, UnknownEntityError } = require('../config/errors');
const { validateDomain, domainDescriptors } = require('../configuration/framework');

/** SHA-256 hex digest (credential hashing for the users area, #65). */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

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

/**
 * @param {{
 *   configService: object,
 *   configDb: object,                      the Configuration Store database
 *   clock: import('../handoff/clock').Clock,
 *   identityProviderKeys?: () => string[], registered user-auth providers
 *                          (also surfaced in describe() for the portal)
 *   validationContext?: () => object, the FULL structured write-validation
 *                          context for configuration domains (ADR-0016):
 *                          composition supplies every registry's keys
 *                          (identity/conversation/notification/integration
 *                          providers, integration types, workflow types, …)
 *                          so provider-selection writes fail loudly when
 *                          misconfigured — no domain knowledge lives here
 *   telemetry?: { event: Function },
 * }} deps
 */
function createAdministrationService({ configService, configDb, clock, identityProviderKeys = () => [], validationContext = () => ({}), configurationAuthority = () => ({ mode: 'live', seedOnBoot: false, lastBootImport: 'none' }), userDirectory = null, assignableRoles = () => [], telemetry }) {
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

  /**
   * A change area generated from a registered configuration domain
   * (ADR-0016): the domain's own normalizer validates STRICTLY (zero
   * issues) and only the canonical normalized document is persisted —
   * administration cannot bypass the Configuration Framework, and a new
   * domain registration becomes administrable with no code here.
   */
  const domainArea = (descriptor) => ({
    apply: (ctx, payload) => {
      const { ok, issues, normalized } = validateDomain(descriptor.id, payload, {
        configService,
        organizationKey: ctx.organizationKey,
        identityProviderKeys: identityProviderKeys(),
        // Structured, composition-supplied context (ADR-0016): each
        // provider-selection domain picks the keys it validates against.
        ...validationContext(),
      });
      if (!ok) {
        throw new ValidationError(`The ${descriptor.title} configuration is invalid.`,
          issues.map((message) => ({ field: descriptor.id, message })));
      }
      const entity = `setting:${descriptor.namespace}/${descriptor.key}`;
      return administer({
        ...ctx,
        entity,
        action: 'update',
        before: settingValue(ctx.organizationKey, descriptor.namespace, descriptor.key),
        change: () => {
          configService.settings.set(ctx.organizationKey, descriptor.namespace, descriptor.key, normalized);
          return normalized;
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

    // Consultation types: the firm-wide appointment kinds the Console
    // requires on every call. Same catalog discipline as practice areas.
    'consultation-types': {
      apply: (ctx, payload) => {
        const { action, key, fields } = payload || {};
        if (action === 'create') {
          return administer({
            ...ctx, entity: 'consultation-types', action: 'create',
            change: () => configService.consultationTypes.create(ctx.organizationKey, fields),
          });
        }
        if (action === 'update' && typeof key === 'string') {
          return administer({
            ...ctx, entity: `consultation-type:${key}`, action: 'update',
            before: configService.consultationTypes.get(ctx.organizationKey, key),
            change: () => configService.consultationTypes.update(ctx.organizationKey, key, fields),
          });
        }
        throw new ValidationError('consultation-types requires action create|update.', []);
      },
    },

    // Routing groups: creation and practice-area assignment (`serviceArea`
    // is a practice-area key; the store resolves and enforces same-org).
    // Membership/order continues to live in the attorney-order area.
    'routing-groups': {
      apply: (ctx, payload) => {
        const { action, key, fields } = payload || {};
        if (action === 'create') {
          return administer({
            ...ctx, entity: 'routing-groups', action: 'create',
            change: () => configService.routingGroups.create(ctx.organizationKey, fields),
          });
        }
        if (action === 'update' && typeof key === 'string') {
          return administer({
            ...ctx, entity: `routing-group:${key}`, action: 'update',
            before: configService.routingGroups.get(ctx.organizationKey, key),
            change: () => configService.routingGroups.update(ctx.organizationKey, key, fields),
          });
        }
        throw new ValidationError('routing-groups requires action create|update.', []);
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

    // User management (#65): organization-scoped users behind the dev-user
    // provider, with the framework's full guarantees. Registered only when
    // a User Directory exists (it does whenever administration does — both
    // require the Configuration Store database).
    //
    // Credential discipline: raw credentials are generated server-side,
    // returned ONCE in the apply response (`issuedCredential`, assembled
    // OUTSIDE administer() so it can never reach an audit snapshot), and
    // stored only as SHA-256 digests. Directory records structurally
    // exclude the digest, so before/after audit snapshots cannot leak it.
    ...(userDirectory ? { users: {
      apply: (ctx, payload) => {
        const { action, subject, fields } = payload || {};
        const org = ctx.organizationKey;

        const checkRoles = (roles) => {
          const allowed = assignableRoles();
          const bad = (Array.isArray(roles) ? roles : []).filter((r) => !allowed.includes(r));
          if (bad.length > 0) {
            throw new ValidationError('One or more roles are not assignable.',
              bad.map((r) => ({ field: 'roles', message: `unknown role: ${r}` })));
          }
        };
        // Lockout guards, both evaluated against DIRECTORY-managed users
        // (deployment-bootstrap users are invisible here and act as an
        // additional recovery path — erring conservative).
        const requireAnotherAdministrator = (record, message) => {
          const isActiveAdmin = record.active && record.roles.includes('administrator');
          if (isActiveAdmin && userDirectory.countActiveAdministrators(org) <= 1) {
            throw new ValidationError(message, [{ field: 'subject', message }]);
          }
        };
        const issueCredential = () => 'ghu-' + crypto.randomBytes(24).toString('base64url');

        if (action === 'create') {
          const { roles, displayName } = fields || {};
          checkRoles(roles);
          const raw = issueCredential();
          const out = administer({
            ...ctx, entity: 'users', action: 'create',
            change: () => userDirectory.create(org, { subject: fields && fields.subject, displayName, roles }, sha256Hex(raw)),
          });
          return { ...out, issuedCredential: raw };
        }
        if (typeof subject !== 'string' || subject === '') {
          throw new ValidationError('users requires action create|update|set-roles|activate|deactivate|rotate-credential (and a subject for all but create).', []);
        }
        const before = userDirectory.get(org, subject);
        if (!before) throw new UnknownEntityError('user');

        if (action === 'update') {
          return administer({
            ...ctx, entity: `user:${subject}`, action: 'update', before,
            change: () => userDirectory.update(org, subject, fields || {}),
          });
        }
        if (action === 'set-roles') {
          const roles = (fields || {}).roles;
          checkRoles(roles);
          if (!Array.isArray(roles) || !roles.includes('administrator')) {
            requireAnotherAdministrator(before, 'Cannot remove the administrator role from the last active administrator.');
          }
          return administer({
            ...ctx, entity: `user:${subject}`, action: 'set-roles', before,
            change: () => userDirectory.setRoles(org, subject, roles),
          });
        }
        if (action === 'deactivate') {
          if (ctx.actor === subject) {
            throw new ValidationError('Administrators cannot deactivate their own account.', [
              { field: 'subject', message: 'self-deactivation is not permitted' },
            ]);
          }
          requireAnotherAdministrator(before, 'Cannot deactivate the last active administrator.');
          return administer({
            ...ctx, entity: `user:${subject}`, action: 'deactivate', before,
            change: () => userDirectory.setActive(org, subject, false),
          });
        }
        if (action === 'activate') {
          return administer({
            ...ctx, entity: `user:${subject}`, action: 'activate', before,
            change: () => userDirectory.setActive(org, subject, true),
          });
        }
        if (action === 'rotate-credential') {
          const raw = issueCredential();
          const out = administer({
            ...ctx, entity: `user:${subject}`, action: 'rotate-credential', before,
            change: () => userDirectory.setCredentialHash(org, subject, sha256Hex(raw)),
          });
          return { ...out, issuedCredential: raw };
        }
        throw new ValidationError('users requires action create|update|set-roles|activate|deactivate|rotate-credential.', []);
      },
    } } : {}),

  };

  // Every registered configuration domain is administrable, generated
  // from the registry (ADR-0016) — one registration, one area, no code.
  for (const descriptor of domainDescriptors()) {
    areas[descriptor.id] = domainArea(descriptor);
  }

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
        consultationTypes: configService.consultationTypes.list(organizationKey, {}),
        attorneys: configService.providers.list(organizationKey, {}),
        routingGroups: configService.routingGroups.list(organizationKey, {}),
        locations: configService.locations.list(organizationKey, {}),
        settings: Object.fromEntries(domainDescriptors().map((d) => [
          d.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
          {
            value: settingValue(organizationKey, d.namespace, d.key),
            version: versionOf(`setting:${d.namespace}/${d.key}`),
            live: d.live,
          },
        ])),
        registeredIdentityProviders: identityProviderKeys(),
        // Whether writes made here are authoritative (ADR-0022): `live`
        // means yes; `seed-managed` means a recurring boot-time re-import
        // overwrites them, and the portal shows a warning banner.
        configurationAuthority: configurationAuthority(),
        // User management (#65): directory records carry no credential
        // material by construction. Absent directory → empty list.
        users: userDirectory ? userDirectory.list(organizationKey) : [],
        assignableRoles: assignableRoles(),
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
