-- 0001-initial — GuideHerd Configuration Store schema.
--
-- Industry-neutral naming (see config/models.js for the mapping to GuideHerd
-- domain language): organizations are firms, providers are attorneys,
-- service_areas are practice areas in the legal vertical.
--
-- Conventions:
--  * Integer row ids are internal to the store; stable string `key` columns
--    (kebab-case, unique per organization) are the public identifiers.
--  * `active` is a soft flag (0/1); configuration is deactivated, not deleted.
--  * Timestamps are ISO-8601 UTC text.
--  * This store holds configuration and reference data only. Clients,
--    sessions, appointments, and other operational data belong to the future
--    Operational Store, never here.

CREATE TABLE organizations (
  id            INTEGER PRIMARY KEY,
  key           TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  display_name  TEXT,
  timezone      TEXT    NOT NULL DEFAULT 'UTC',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE locations (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT,
  region          TEXT,
  postal_code     TEXT,
  phone           TEXT,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (organization_id, key)
);

-- day_of_week: 0 = Sunday … 6 = Saturday.
-- opens/closes: HH:MM 24-hour, in the location's local time.
-- The (location, day, opens) uniqueness allows split shifts on one day.
CREATE TABLE office_hours (
  id          INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens       TEXT    NOT NULL,
  closes      TEXT    NOT NULL,
  UNIQUE (location_id, day_of_week, opens)
);

CREATE TABLE providers (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  display_name    TEXT,
  email           TEXT,
  phone           TEXT,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (organization_id, key)
);

CREATE TABLE service_areas (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (organization_id, key)
);

CREATE TABLE consultation_types (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (organization_id, key)
);

-- A routing group is how one service area routes to providers. Several
-- groups may serve the same service area; every group serves exactly one.
CREATE TABLE routing_groups (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_area_id INTEGER NOT NULL REFERENCES service_areas(id),
  key             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (organization_id, key)
);

-- A provider may belong to many groups; a group may route to many providers.
CREATE TABLE routing_group_members (
  group_id    INTEGER NOT NULL REFERENCES routing_groups(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, provider_id)
);

-- Namespaced key/value JSON settings. Future configuration families
-- (voice, AI employees, notifications) live here until they mature enough
-- to earn dedicated tables via a later migration.
CREATE TABLE settings (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  namespace       TEXT    NOT NULL,
  key             TEXT    NOT NULL,
  value           TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (organization_id, namespace, key)
);

CREATE INDEX idx_locations_org          ON locations(organization_id);
CREATE INDEX idx_office_hours_location  ON office_hours(location_id);
CREATE INDEX idx_providers_org          ON providers(organization_id);
CREATE INDEX idx_service_areas_org      ON service_areas(organization_id);
CREATE INDEX idx_consultation_types_org ON consultation_types(organization_id);
CREATE INDEX idx_routing_groups_org     ON routing_groups(organization_id);
CREATE INDEX idx_routing_groups_area    ON routing_groups(service_area_id);
CREATE INDEX idx_settings_org_ns        ON settings(organization_id, namespace);
