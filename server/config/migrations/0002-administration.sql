-- Configuration Store 0002: administration audit + versioning (ADR-0015).
--
-- One row per administered configuration change. `version` is monotonic
-- per (organization_key, entity) and drives optimistic concurrency: a
-- write must name the version it read, and the audit insert happens in
-- the same transaction as the change — a concurrent writer loses with an
-- explicit conflict, never a silent overwrite. before/after snapshots
-- lay the foundation for future rollback (no rollback UI in this ticket).
--
-- Never stored here: secrets, credentials, tokens, caller PII. Audited
-- payloads are configuration documents only.

CREATE TABLE configuration_audit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_key TEXT NOT NULL,
  entity           TEXT NOT NULL,   -- e.g. 'setting:scheduling/policy', 'attorney:clay-martinson'
  action           TEXT NOT NULL,   -- e.g. 'update', 'create', 'reorder'
  actor            TEXT NOT NULL,   -- GuideHerd identity subject
  version          INTEGER NOT NULL,
  before_json      TEXT,
  after_json       TEXT,
  at               TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_configuration_audit_version
  ON configuration_audit (organization_key, entity, version);

CREATE INDEX idx_configuration_audit_recent
  ON configuration_audit (organization_key, id DESC);

-- Attorney ordering (ADR-0015): routing-group members gain an explicit
-- position. Legacy rows default to 0, so pre-existing groups keep their
-- previous effective (alphabetical) order until administered.
ALTER TABLE routing_group_members ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
