'use strict';

/**
 * SQLite-backed repositories for the Configuration Store.
 *
 * This is the only module that contains SQL. Callers pass and receive plain
 * objects with camelCase properties; each repository owns its column mapping.
 * Integer row ids appear on returned rows for composition inside the service
 * layer, but the service strips them before anything leaves the module.
 *
 * All methods are synchronous (node:sqlite is a synchronous API), matching
 * the single-pass discipline used elsewhere in this server.
 */

/**
 * Entities sharing the (organization_id, key, name, active, timestamps)
 * shape are served by one repository factory. `extraCols` maps additional
 * camelCase properties to their snake_case columns.
 */
const CATALOG_TABLES = Object.freeze({
  locations: {
    extraCols: {
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      city: 'city',
      region: 'region',
      postalCode: 'postal_code',
      phone: 'phone',
    },
    orderBy: 'key',
  },
  providers: {
    extraCols: { displayName: 'display_name', email: 'email', phone: 'phone' },
    orderBy: 'key',
  },
  service_areas: {
    extraCols: { displayOrder: 'display_order' },
    orderBy: 'display_order, key',
  },
  consultation_types: {
    extraCols: { displayOrder: 'display_order' },
    orderBy: 'display_order, key',
  },
  routing_groups: {
    extraCols: { serviceAreaId: 'service_area_id' },
    orderBy: 'key',
  },
});

function toBool(value) {
  return value === 1;
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 */
function createConfigStore({ db }) {
  /** Shared partial UPDATE by row id. `colValues` maps column -> value. */
  function updateById(table, id, colValues) {
    const cols = Object.keys(colValues);
    if (cols.length === 0) return;
    const sets = cols.map((col) => `${col} = ?`).join(', ');
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`)
      .run(...cols.map((col) => colValues[col]), id);
  }

  // ── Organizations ──────────────────────────────────────────────────────────

  function mapOrganization(row) {
    if (!row) return undefined;
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      displayName: row.display_name ?? null,
      timezone: row.timezone,
      active: toBool(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const organizations = {
    /** @returns {Object} the inserted row */
    insert(org, nowIso) {
      db.prepare(
        `INSERT INTO organizations (key, name, display_name, timezone, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        org.key, org.name, org.displayName ?? null, org.timezone,
        org.active ? 1 : 0, nowIso, nowIso,
      );
      return this.getByKey(org.key);
    },

    getByKey(key) {
      return mapOrganization(
        db.prepare('SELECT * FROM organizations WHERE key = ?').get(key),
      );
    },

    list({ activeOnly = false } = {}) {
      const sql = 'SELECT * FROM organizations'
        + (activeOnly ? ' WHERE active = 1' : '')
        + ' ORDER BY key';
      return db.prepare(sql).all().map(mapOrganization);
    },

    /** Sparse update; `patch` uses camelCase props. */
    update(id, patch, nowIso) {
      const colValues = { updated_at: nowIso };
      if (patch.name !== undefined) colValues.name = patch.name;
      if (patch.displayName !== undefined) colValues.display_name = patch.displayName;
      if (patch.timezone !== undefined) colValues.timezone = patch.timezone;
      if (patch.active !== undefined) colValues.active = patch.active ? 1 : 0;
      updateById('organizations', id, colValues);
    },
  };

  // ── Catalog repositories (locations, providers, areas, types, groups) ─────

  function catalogRepo(table) {
    const { extraCols, orderBy } = CATALOG_TABLES[table];

    function mapRow(row) {
      if (!row) return undefined;
      const mapped = {
        id: row.id,
        organizationId: row.organization_id,
        key: row.key,
        name: row.name,
        active: toBool(row.active),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      for (const [prop, col] of Object.entries(extraCols)) {
        mapped[prop] = row[col] ?? (prop === 'displayOrder' ? 0 : null);
      }
      return mapped;
    }

    return {
      insert(organizationId, entity, nowIso) {
        const props = Object.keys(extraCols);
        const cols = ['organization_id', 'key', 'name', ...props.map((p) => extraCols[p]), 'active', 'created_at', 'updated_at'];
        const placeholders = cols.map(() => '?').join(', ');
        const values = [
          organizationId, entity.key, entity.name,
          ...props.map((p) => entity[p] ?? (p === 'displayOrder' ? 0 : null)),
          entity.active ? 1 : 0, nowIso, nowIso,
        ];
        db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
        return this.getByKey(organizationId, entity.key);
      },

      getByKey(organizationId, key) {
        return mapRow(
          db.prepare(`SELECT * FROM ${table} WHERE organization_id = ? AND key = ?`)
            .get(organizationId, key),
        );
      },

      getById(id) {
        return mapRow(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
      },

      listByOrg(organizationId, { activeOnly = false } = {}) {
        const sql = `SELECT * FROM ${table} WHERE organization_id = ?`
          + (activeOnly ? ' AND active = 1' : '')
          + ` ORDER BY ${orderBy}`;
        return db.prepare(sql).all(organizationId).map(mapRow);
      },

      /** Sparse update; `patch` uses camelCase props. */
      update(id, patch, nowIso) {
        const colValues = { updated_at: nowIso };
        if (patch.name !== undefined) colValues.name = patch.name;
        if (patch.active !== undefined) colValues.active = patch.active ? 1 : 0;
        for (const [prop, col] of Object.entries(extraCols)) {
          if (patch[prop] !== undefined) colValues[col] = patch[prop];
        }
        updateById(table, id, colValues);
      },
    };
  }

  const locations = catalogRepo('locations');
  const providers = catalogRepo('providers');
  const serviceAreas = catalogRepo('service_areas');
  const consultationTypes = catalogRepo('consultation_types');
  const routingGroups = catalogRepo('routing_groups');

  // ── Office hours ───────────────────────────────────────────────────────────

  const officeHours = {
    /** Replace-all semantics: a location's weekly hours are set atomically. */
    replaceForLocation(locationId, hours) {
      db.prepare('DELETE FROM office_hours WHERE location_id = ?').run(locationId);
      const insert = db.prepare(
        'INSERT INTO office_hours (location_id, day_of_week, opens, closes) VALUES (?, ?, ?, ?)',
      );
      for (const hour of hours) {
        insert.run(locationId, hour.dayOfWeek, hour.opens, hour.closes);
      }
    },

    listByLocation(locationId) {
      return db.prepare(
        'SELECT day_of_week, opens, closes FROM office_hours WHERE location_id = ? ORDER BY day_of_week, opens',
      ).all(locationId).map((row) => ({
        dayOfWeek: row.day_of_week,
        opens: row.opens,
        closes: row.closes,
      }));
    },
  };

  // ── Routing group members ──────────────────────────────────────────────────

  const routingGroupMembers = {
    /** Replace-all semantics: group membership is set atomically. */
    replaceForGroup(groupId, providerIds) {
      db.prepare('DELETE FROM routing_group_members WHERE group_id = ?').run(groupId);
      const insert = db.prepare(
        'INSERT INTO routing_group_members (group_id, provider_id) VALUES (?, ?)',
      );
      for (const providerId of providerIds) {
        insert.run(groupId, providerId);
      }
    },

    /** Member provider keys, ordered. */
    listProviderKeys(groupId) {
      return db.prepare(
        `SELECT p.key FROM routing_group_members m
         JOIN providers p ON p.id = m.provider_id
         WHERE m.group_id = ? ORDER BY p.key`,
      ).all(groupId).map((row) => row.key);
    },
  };

  // ── Settings ───────────────────────────────────────────────────────────────

  const settings = {
    upsert(organizationId, namespace, key, valueJson, nowIso) {
      db.prepare(
        `INSERT INTO settings (organization_id, namespace, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, namespace, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(organizationId, namespace, key, valueJson, nowIso);
    },

    get(organizationId, namespace, key) {
      const row = db.prepare(
        'SELECT namespace, key, value, updated_at FROM settings WHERE organization_id = ? AND namespace = ? AND key = ?',
      ).get(organizationId, namespace, key);
      if (!row) return undefined;
      return { namespace: row.namespace, key: row.key, valueJson: row.value, updatedAt: row.updated_at };
    },

    list(organizationId, namespace) {
      const sql = 'SELECT namespace, key, value, updated_at FROM settings WHERE organization_id = ?'
        + (namespace !== undefined ? ' AND namespace = ?' : '')
        + ' ORDER BY namespace, key';
      const rows = namespace !== undefined
        ? db.prepare(sql).all(organizationId, namespace)
        : db.prepare(sql).all(organizationId);
      return rows.map((row) => ({
        namespace: row.namespace, key: row.key, valueJson: row.value, updatedAt: row.updated_at,
      }));
    },

    /** @returns {boolean} true when a row was deleted */
    remove(organizationId, namespace, key) {
      const result = db.prepare(
        'DELETE FROM settings WHERE organization_id = ? AND namespace = ? AND key = ?',
      ).run(organizationId, namespace, key);
      return result.changes > 0;
    },
  };

  // ── Transactions ───────────────────────────────────────────────────────────

  /**
   * Run `fn` inside a single transaction. Not re-entrant (SQLite has no
   * nested BEGIN); individual repository calls outside a transaction are
   * already atomic statements.
   */
  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    organizations,
    locations,
    providers,
    serviceAreas,
    consultationTypes,
    routingGroups,
    officeHours,
    routingGroupMembers,
    settings,
    transaction,
  };
}

module.exports = { createConfigStore };
