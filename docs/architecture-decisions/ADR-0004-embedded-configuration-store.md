# ADR-0004: Embedded SQLite Configuration Store

**Status:** Proposed
**Date:** 2026-07-14
**Relates to:** issue #26 (GuideHerd Configuration Store)

## Context

GuideHerd needs per-customer configuration — firms, attorneys, practice
areas, consultation types, routing groups, office hours, and future settings
families — that runs alongside GuideHerd services on customer hardware
without SQL Server licensing or external infrastructure. The data is
relatively static reference data, not high-volume transactional data.

Two constraints shape the decision:

1. The server codebase has a zero-runtime-dependency rule (Node built-ins
   only), which has kept it small, auditable, and trivially deployable.
2. Configuration must stay decoupled from the demo/session flow: the Context
   Handoff API, its storage, and its contracts are explicitly out of scope.

## Decision

1. **SQLite, via the Node built-in `node:sqlite` module.** No external
   dependency, single-file database, cross-platform, no license, backed up by
   copying one file. This raises the required Node version from 20 to 22.5
   (the module is flag-free from 22.13 / 23.4; the npm scripts pass
   `--experimental-sqlite`, which newer versions accept harmlessly).

2. **A separate Configuration Store, not an extension of session storage.**
   The store lives in `server/config/`, a sibling of `server/handoff/`, with
   no imports in either direction. Operational data (clients, sessions,
   conversations, appointments, notifications, audit history) is explicitly
   excluded and will live in a future Operational Store with its own
   lifecycle, backups, and growth profile.

3. **Industry-neutral schema, GuideHerd domain language at the edges.**
   Tables are `organizations`, `providers`, `service_areas`,
   `consultation_types`, `routing_groups`, `locations`, `office_hours`,
   `settings`. Legal-vertical terms (Firm, Attorney, Practice Area) map onto
   these at the presentation layer. Stable kebab-case `key` columns — the
   same identifiers already used in GuideHerd contracts — are the public
   identifiers; integer row ids never leave the store layer.

4. **Future configuration families start as namespaced settings.** AI
   employees, voice configuration, and notification preferences live in a
   `settings` (organization, namespace, key, JSON value) table until they
   mature enough to earn dedicated tables via a migration.

5. **Repository/service boundary, library-first.** `store.js` is the only
   module containing SQL; `service.js` owns validation and business rules and
   is consumed in-process. No HTTP surface ships in the first pass — data
   enters through a seed/import CLI, and the future Administration Portal
   will be the write-side front end.

## Consequences

- Customer configuration is deployable as one `.db` file next to the service;
  backup is a file copy (WAL mode; `VACUUM INTO` for a consistent snapshot).
- The Node baseline moves to 22.5+ for the server package.
- Schema evolution goes through numbered SQL migrations
  (`config/migrations/NNNN-*.sql`) applied transactionally at startup or by
  the seed CLI; migrations are recorded in `schema_migrations`.
- A future multi-service or hosted deployment can replace SQLite behind the
  same repository interface without touching the service layer or its
  consumers, per ADR-0003 (hide dependencies behind GuideHerd services).
