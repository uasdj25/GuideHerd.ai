'use strict';

const { systemClock } = require('./clock');
const { createConfigStore } = require('./store');
const {
  ValidationError,
  UnknownEntityError,
  DuplicateKeyError,
} = require('./errors');
const {
  normalizeOrganization,
  normalizeLocation,
  normalizeOfficeHours,
  normalizeProvider,
  normalizeCatalogItem,
  normalizeRoutingGroup,
  normalizeSetting,
  normalizePatch,
} = require('./validation');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Detect a SQLite unique-constraint violation without vendor types leaking upward. */
function isUniqueViolation(err) {
  return /UNIQUE constraint failed/.test(String(err && err.message));
}

/**
 * Configuration Store service.
 *
 * All operations address entities by their stable string keys, scoped to an
 * organization key — integer row ids never cross this boundary. Every public
 * return value is a plain object safe to serialize.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, clock?: import('./clock').Clock }} deps
 */
function createConfigService({ db, clock = systemClock() }) {
  const store = createConfigStore({ db });

  const nowIso = () => new Date(clock.now()).toISOString();

  /** Strip internal row identifiers before anything leaves the service. */
  function present(row) {
    if (!row) return row;
    const { id, organizationId, ...publicShape } = row;
    return publicShape;
  }

  function requireOrganizationRow(orgKey) {
    const org = store.organizations.getByKey(orgKey);
    if (!org) throw new UnknownEntityError('organization');
    return org;
  }

  function withDuplicateMapping(entity, fn) {
    try {
      return fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateKeyError(entity);
      throw err;
    }
  }

  // ── Organizations ──────────────────────────────────────────────────────────

  const organizations = {
    create(input) {
      const normalized = normalizeOrganization(input);
      return withDuplicateMapping('organization', () =>
        present(store.organizations.insert(normalized, nowIso())));
    },

    get(orgKey) {
      return present(requireOrganizationRow(orgKey));
    },

    list(options) {
      return store.organizations.list(options).map(present);
    },

    update(orgKey, patchBody) {
      const org = requireOrganizationRow(orgKey);
      const patch = normalizePatch(patchBody, ['name', 'displayName', 'timezone', 'active']);
      store.organizations.update(org.id, patch, nowIso());
      return this.get(orgKey);
    },
  };

  // ── Catalog entities (shared behavior) ─────────────────────────────────────

  /**
   * @param {Object} repo store repository
   * @param {string} entity singular snake_case name for errors
   * @param {(body: unknown) => Object} normalize create-input validator
   * @param {string[]} patchFields updatable fields
   * @param {(row: Object) => Object} [decorate] enrich a presented row
   */
  function catalogService(repo, entity, normalize, patchFields, decorate) {
    const finish = (row) => (decorate ? decorate(row) : present(row));
    return {
      create(orgKey, input) {
        const org = requireOrganizationRow(orgKey);
        const normalized = normalize(input);
        return withDuplicateMapping(entity, () =>
          finish(repo.insert(org.id, normalized, nowIso())));
      },

      get(orgKey, key) {
        const org = requireOrganizationRow(orgKey);
        const row = repo.getByKey(org.id, key);
        if (!row) throw new UnknownEntityError(entity);
        return finish(row);
      },

      list(orgKey, options) {
        const org = requireOrganizationRow(orgKey);
        return repo.listByOrg(org.id, options).map(finish);
      },

      update(orgKey, key, patchBody) {
        const org = requireOrganizationRow(orgKey);
        const row = repo.getByKey(org.id, key);
        if (!row) throw new UnknownEntityError(entity);
        const patch = normalizePatch(patchBody, patchFields);
        repo.update(row.id, patch, nowIso());
        return this.get(orgKey, key);
      },
    };
  }

  // ── Locations (catalog + office hours) ─────────────────────────────────────

  const locationDecorate = (row) => {
    const pub = present(row);
    pub.officeHours = store.officeHours.listByLocation(row.id);
    return pub;
  };

  const locationsBase = catalogService(
    store.locations, 'location', normalizeLocation,
    ['name', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'phone', 'active'],
    locationDecorate,
  );

  const locations = {
    ...locationsBase,

    create(orgKey, input) {
      const org = requireOrganizationRow(orgKey);
      const normalized = normalizeLocation(input);
      const { officeHours, ...locationFields } = normalized;
      return withDuplicateMapping('location', () => store.transaction(() => {
        const row = store.locations.insert(org.id, locationFields, nowIso());
        if (officeHours) store.officeHours.replaceForLocation(row.id, officeHours);
        return locationDecorate(row);
      }));
    },

    /** Replace a location's full weekly hours atomically. */
    setOfficeHours(orgKey, locationKey, hours) {
      const org = requireOrganizationRow(orgKey);
      const row = store.locations.getByKey(org.id, locationKey);
      if (!row) throw new UnknownEntityError('location');
      const normalized = normalizeOfficeHours(hours);
      store.transaction(() => {
        store.officeHours.replaceForLocation(row.id, normalized);
      });
      return locationDecorate(store.locations.getByKey(org.id, locationKey));
    },
  };

  // ── Providers, service areas, consultation types ───────────────────────────

  const providers = catalogService(
    store.providers, 'provider', normalizeProvider,
    ['name', 'displayName', 'email', 'phone', 'active'],
  );

  const serviceAreas = catalogService(
    store.serviceAreas, 'service_area', normalizeCatalogItem,
    ['name', 'displayOrder', 'active'],
  );

  const consultationTypes = catalogService(
    store.consultationTypes, 'consultation_type', normalizeCatalogItem,
    ['name', 'displayOrder', 'active'],
  );

  // ── Routing groups ─────────────────────────────────────────────────────────

  const groupDecorate = (row) => {
    const pub = present(row);
    delete pub.serviceAreaId;
    pub.serviceArea = store.serviceAreas.getById(row.serviceAreaId).key;
    pub.providers = store.routingGroupMembers.listProviderKeys(row.id);
    return pub;
  };

  /** Resolve a service-area key to its same-organization row id. */
  function resolveServiceAreaId(orgId, serviceAreaKey) {
    const area = store.serviceAreas.getByKey(orgId, serviceAreaKey);
    if (!area) throw new UnknownEntityError('service_area');
    return area.id;
  }

  /** Resolve provider keys to same-organization row ids; all must exist. */
  function resolveProviderIds(orgId, providerKeys) {
    return providerKeys.map((key) => {
      const provider = store.providers.getByKey(orgId, key);
      if (!provider) throw new UnknownEntityError('provider');
      return provider.id;
    });
  }

  const routingGroupsBase = catalogService(
    store.routingGroups, 'routing_group', normalizeRoutingGroup,
    ['name', 'active'],
    groupDecorate,
  );

  const routingGroups = {
    ...routingGroupsBase,

    create(orgKey, input) {
      const org = requireOrganizationRow(orgKey);
      const normalized = normalizeRoutingGroup(input);
      const { providers: providerKeys, serviceArea, ...groupFields } = normalized;
      groupFields.serviceAreaId = resolveServiceAreaId(org.id, serviceArea);
      return withDuplicateMapping('routing_group', () => store.transaction(() => {
        const row = store.routingGroups.insert(org.id, groupFields, nowIso());
        if (providerKeys) {
          store.routingGroupMembers.replaceForGroup(row.id, resolveProviderIds(org.id, providerKeys));
        }
        return groupDecorate(row);
      }));
    },

    /** `serviceArea` in a patch is a service-area key within the same organization. */
    update(orgKey, key, patchBody) {
      const org = requireOrganizationRow(orgKey);
      const row = store.routingGroups.getByKey(org.id, key);
      if (!row) throw new UnknownEntityError('routing_group');
      const patch = normalizePatch(patchBody, ['name', 'serviceArea', 'active']);
      if (patch.serviceArea !== undefined) {
        patch.serviceAreaId = resolveServiceAreaId(org.id, patch.serviceArea);
        delete patch.serviceArea;
      }
      store.routingGroups.update(row.id, patch, nowIso());
      return this.get(orgKey, key);
    },

    /** Replace a group's membership atomically. Providers must exist in the same organization. */
    setProviders(orgKey, groupKey, providerKeys) {
      const org = requireOrganizationRow(orgKey);
      const row = store.routingGroups.getByKey(org.id, groupKey);
      if (!row) throw new UnknownEntityError('routing_group');
      if (!Array.isArray(providerKeys)) {
        throw new ValidationError('One or more fields are invalid.', [
          { field: 'providers', message: 'must be an array of provider keys' },
        ]);
      }
      store.transaction(() => {
        store.routingGroupMembers.replaceForGroup(row.id, resolveProviderIds(org.id, providerKeys));
      });
      return groupDecorate(store.routingGroups.getByKey(org.id, groupKey));
    },
  };

  // ── Settings ───────────────────────────────────────────────────────────────

  function presentSetting(stored) {
    return {
      namespace: stored.namespace,
      key: stored.key,
      value: JSON.parse(stored.valueJson),
      updatedAt: stored.updatedAt,
    };
  }

  const settings = {
    set(orgKey, namespace, key, value) {
      const org = requireOrganizationRow(orgKey);
      const normalized = normalizeSetting(namespace, key, value);
      store.settings.upsert(org.id, normalized.namespace, normalized.key, normalized.valueJson, nowIso());
      return this.get(orgKey, normalized.namespace, normalized.key);
    },

    get(orgKey, namespace, key) {
      const org = requireOrganizationRow(orgKey);
      const stored = store.settings.get(org.id, namespace, key);
      if (!stored) throw new UnknownEntityError('setting');
      return presentSetting(stored);
    },

    list(orgKey, namespace) {
      const org = requireOrganizationRow(orgKey);
      return store.settings.list(org.id, namespace).map(presentSetting);
    },

    remove(orgKey, namespace, key) {
      const org = requireOrganizationRow(orgKey);
      const deleted = store.settings.remove(org.id, namespace, key);
      if (!deleted) throw new UnknownEntityError('setting');
    },
  };

  // ── Import / export ────────────────────────────────────────────────────────

  /**
   * Import a full organization configuration document (the seed-file shape),
   * upserting by key inside one transaction. Non-destructive: entities absent
   * from the document are left untouched; office hours and routing-group
   * membership use replace-all semantics when provided.
   *
   * @param {unknown} tree
   * @returns {{organization: string, counts: Object<string, number>}}
   */
  function importOrganization(tree) {
    if (!isPlainObject(tree)) {
      throw new ValidationError('Configuration document must be a JSON object.', [
        { field: '(body)', message: 'must be a JSON object' },
      ]);
    }

    // Validate everything before touching the database.
    const org = normalizeOrganization(tree.organization);
    const collections = {};
    for (const [prop, normalize] of [
      ['locations', normalizeLocation],
      ['providers', normalizeProvider],
      ['serviceAreas', normalizeCatalogItem],
      ['consultationTypes', normalizeCatalogItem],
      ['routingGroups', normalizeRoutingGroup],
    ]) {
      const items = tree[prop];
      if (items === undefined) continue;
      if (!Array.isArray(items)) {
        throw new ValidationError('One or more fields are invalid.', [
          { field: prop, message: 'must be an array' },
        ]);
      }
      collections[prop] = items.map(normalize);
    }
    let settingEntries;
    if (tree.settings !== undefined) {
      if (!Array.isArray(tree.settings)) {
        throw new ValidationError('One or more fields are invalid.', [
          { field: 'settings', message: 'must be an array' },
        ]);
      }
      settingEntries = tree.settings.map((entry) => {
        if (!isPlainObject(entry)) {
          throw new ValidationError('One or more fields are invalid.', [
            { field: 'settings', message: 'entries must be objects' },
          ]);
        }
        return normalizeSetting(entry.namespace, entry.key, entry.value);
      });
    }

    const counts = {};

    store.transaction(() => {
      const now = nowIso();

      // Organization: upsert by key.
      let orgRow = store.organizations.getByKey(org.key);
      if (orgRow) {
        const { key, ...patch } = org;
        store.organizations.update(orgRow.id, patch, now);
      } else {
        orgRow = store.organizations.insert(org, now);
      }
      const orgId = orgRow.id;

      /** Upsert one collection by key; returns processed count. */
      function upsertCollection(repo, items, patchProps, each) {
        let processed = 0;
        for (const item of items) {
          const existing = repo.getByKey(orgId, item.key);
          let row;
          if (existing) {
            const patch = {};
            for (const prop of patchProps) {
              if (item[prop] !== undefined) patch[prop] = item[prop];
            }
            repo.update(existing.id, patch, now);
            row = repo.getByKey(orgId, item.key);
          } else {
            row = repo.insert(orgId, item, now);
          }
          if (each) each(row, item);
          processed += 1;
        }
        return processed;
      }

      if (collections.providers) {
        counts.providers = upsertCollection(
          store.providers, collections.providers,
          ['name', 'displayName', 'email', 'phone', 'active'],
        );
      }
      if (collections.locations) {
        counts.locations = upsertCollection(
          store.locations,
          collections.locations.map(({ officeHours, ...rest }) => rest),
          ['name', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'phone', 'active'],
        );
        // Office hours: replace-all per location when provided.
        for (const location of collections.locations) {
          if (!location.officeHours) continue;
          const row = store.locations.getByKey(orgId, location.key);
          store.officeHours.replaceForLocation(row.id, location.officeHours);
        }
      }
      if (collections.serviceAreas) {
        counts.serviceAreas = upsertCollection(
          store.serviceAreas, collections.serviceAreas,
          ['name', 'displayOrder', 'active'],
        );
      }
      if (collections.consultationTypes) {
        counts.consultationTypes = upsertCollection(
          store.consultationTypes, collections.consultationTypes,
          ['name', 'displayOrder', 'active'],
        );
      }
      if (collections.routingGroups) {
        // Service areas import above, so each group's area key resolves here.
        counts.routingGroups = upsertCollection(
          store.routingGroups,
          collections.routingGroups.map(({ providers: p, serviceArea, ...rest }) => ({
            ...rest,
            serviceAreaId: resolveServiceAreaId(orgId, serviceArea),
          })),
          ['name', 'serviceAreaId', 'active'],
        );
        // Membership: replace-all per group when provided.
        for (const group of collections.routingGroups) {
          if (!group.providers) continue;
          const row = store.routingGroups.getByKey(orgId, group.key);
          store.routingGroupMembers.replaceForGroup(row.id, resolveProviderIds(orgId, group.providers));
        }
      }
      if (settingEntries) {
        for (const entry of settingEntries) {
          store.settings.upsert(orgId, entry.namespace, entry.key, entry.valueJson, now);
        }
        counts.settings = settingEntries.length;
      }
    });

    return { organization: org.key, counts };
  }

  /**
   * Export a full organization configuration document in the seed-file shape.
   * Timestamps and row ids are omitted: the result is a portable configuration
   * document, and `importOrganization(exportOrganization(k))` is a no-op.
   */
  function exportOrganization(orgKey) {
    const org = requireOrganizationRow(orgKey);

    // A portable configuration document carries neither timestamps nor
    // null-valued optionals (omitted and null mean the same thing on import).
    const stripMeta = ({ createdAt, updatedAt, ...rest }) => {
      for (const prop of Object.keys(rest)) {
        if (rest[prop] === null) delete rest[prop];
      }
      return rest;
    };

    return {
      organization: stripMeta({
        key: org.key,
        name: org.name,
        displayName: org.displayName,
        timezone: org.timezone,
        active: org.active,
      }),
      locations: locations.list(orgKey).map(stripMeta),
      providers: providers.list(orgKey).map(stripMeta),
      serviceAreas: serviceAreas.list(orgKey).map(stripMeta),
      consultationTypes: consultationTypes.list(orgKey).map(stripMeta),
      routingGroups: routingGroups.list(orgKey).map(stripMeta),
      settings: settings.list(orgKey).map(({ updatedAt, ...rest }) => rest),
    };
  }

  return {
    organizations,
    /** Compose multiple configuration operations atomically (re-entrant). */
    transaction: (fn) => store.transaction(fn),
    locations,
    providers,
    serviceAreas,
    consultationTypes,
    routingGroups,
    settings,
    importOrganization,
    exportOrganization,
  };
}

module.exports = { createConfigService };
