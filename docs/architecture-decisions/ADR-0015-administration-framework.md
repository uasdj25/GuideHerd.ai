# ADR-0015: The GuideHerd Administration Framework

**Status:** Accepted — implemented and governing on `main`.
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 3, 5), ADR-0004
(Configuration Store — the substrate), ADR-0010/0013 (authorization and
user sessions — which protect it), ADR-0012 (scheduling policy — a
validated consumer), ADR-0011 (notification settings — validated
consumers)

## Context

Configuration changes meant git commits and seed-file edits — and the
seed-on-boot mode re-imports the document on every deploy, which
`server.js` has warned from the start becomes unsafe the moment a live
editing channel exists. This ADR establishes that channel properly: the
permanent administration framework. The web portal is merely its first
client.

## Decision

### 1. Administration is a producer; everything else stays a consumer

The Administration Contract (`server/administration/service.js`) accepts
CHANGE REQUESTS for typed areas — organization, practice areas,
attorneys, attorney ordering, scheduling policy, notification branding,
notification enablement, office information, business hours, identity
provider selection — validates them, and persists through the same
Configuration Store every subsystem already reads. No consumer knows
whether configuration arrived from a git seed, this framework, a CLI, an
import, or a future API. Unknown areas fail loudly
(`unknown_administration_area`); administration modifies configuration,
never architecture. Future modules (voice configuration, provider
management, extensions, branding, localization, integrations, API keys)
are additional typed areas — additive.

### 2. Validation is owned by the consuming subsystem

Delegated wherever a consumer validator exists: catalog and entity rules
to the Configuration Store's normalizers; scheduling policy to the Policy
Engine's `normalizePolicy` — with administration STRICTER than runtime
(runtime degrades invalid fields fail-safe; administration refuses the
whole document); office hours to `normalizeOfficeHours`; identity
provider keys against the registered provider registry (an unregistered
provider would break every login — refused). Where no consumer validator
exists yet (notification branding), administration validates against the
consumer's documented constraints. Partial invalid configuration is never
written: the change and its audit row are one transaction.

### 3. Versioning, optimistic concurrency, audit — and the rollback foundation

Every change writes a `configuration_audit` row (config migration 0002):
monotonic version per (organization, entity), actor, action, and
before/after snapshots, inserted in the same re-entrant Configuration
Store transaction as the change itself. Writers
supply the `expectedVersion` they read; a mismatch is an explicit
`409 configuration_version_conflict` and nothing is written — concurrent
administrators can never silently overwrite each other. The snapshots
are the foundation for future rollback; no rollback UI ships here.

**Re-entrant transactions are a Configuration Store capability, not an
administration detail.** The store's single `transaction()` primitive
gained savepoint-based nesting: the outermost call is a real
BEGIN/COMMIT, nested calls become savepoints with correct partial
rollback. Every existing caller composes unchanged, and this is now the
STANDARD primitive for any future multi-step Configuration Store
operation (exposed as `configService.transaction`). Administration was
merely the first composition that needed it. Scope note: this is the
Configuration Store's primitive (embedded SQLite, synchronous); the
Operational Store keeps its own PostgreSQL transaction discipline
(ADR-0006) — the two are deliberately not unified.

### 4. Authorization

Administration requires a GuideHerd user session (never anonymous,
regardless of the console floor) plus the new `administration:read` /
`administration:write` permissions, held by the org-scoped built-in
`administrator` role. Receptionists and operators are NOT administrators.
The organization and actor come exclusively from the server-held session
— no admin route accepts an organization identifier, so
cross-organization administration is structurally impossible. Every write
is authorization-audited and telemetry-evented
(`configuration.changed`).

**Addendum (#65 — the users area.)** User management is an administration
area with the framework's full guarantees: org-scoped CRUD, role
assignment bounded to exactly the authorization policy's roles (ADR-0010
— administration can never widen the vocabulary), activate/deactivate
with immediate session effect (ADR-0013 addendum), and credential
issuance/rotation where the raw credential exists only in the issuance
response — assembled outside the audited transaction, so before/after
snapshots structurally cannot contain credential material. Lockout
guards: no self-deactivation; the last active directory-managed
administrator can be neither deactivated nor de-roled; and
deployment-provisioned (bootstrap) identities are entirely outside this
area's reach — they cannot be shadowed by a same-subject directory
record, and no directory state governs their sessions (ADR-0013
addendum: deployment wins). There is consequently NO sequence of
administration actions that removes the deployment's recovery path.

### 5. Live vs restart-required configuration

**LIVE** (consumers read the Configuration Store per request — an
administered change affects the very next request, no restart; proven in
tests): organization profile, practice areas, attorneys, attorney
ordering (routing-group member `position`, migration 0002), scheduling
policy, notification branding, notification enablement, office
information, business hours, identity provider selection, plus the
existing conversation-provider and notification-provider settings.

**RESTART REQUIRED** (deployment wiring, deliberately environment-owned):
operational store provider (`GUIDEHERD_OPERATIONAL_PROVIDER`), console
authentication floor (`GUIDEHERD_CONSOLE_AUTH`), static service
identities and dev users (`GUIDEHERD_STATIC_IDENTITIES`,
`GUIDEHERD_DEV_USERS`), active user-auth provider
(`GUIDEHERD_USER_AUTH_PROVIDER`), session TTL, prepared-session cap
default, provider/extension registration, and mail/bridge credentials.
These alter platform wiring or hold secrets — configuration data may
never carry them (ADR-0007 §6).

### 6. Seed-file transition — the permanent configuration lifecycle

`GUIDEHERD_SEED_FILE` re-imports the git document on every boot and
would silently roll administered changes back on the next deploy —
exactly the hazard `server.js` has documented since the seed mode
shipped. The near-term activation prerequisite stands: BEFORE
administrator users are provisioned in production, the deployment drops
the seed variable. Until then the framework is dark and
git-as-source-of-truth remains intentional.

The PERMANENT lifecycle this ADR commits to (the operational step above
is the interim, not the end state):

1. **Bootstrap** — a fresh environment seeds its empty store from the
   configuration document (today's boot-time import exists because the
   deployment's filesystem is ephemeral: without the seed, every deploy
   would boot an empty store).
2. **Durability milestone (prerequisite)** — the Configuration Store
   gains a durable home (a mounted volume for the SQLite file, or a
   PostgreSQL configuration backend); a deployment change needing its
   own approval.
3. **Transition** — the final seed import becomes the store's initial
   state and the boot-time re-import retires. Boot seeding survives only
   as **seed-if-empty**: it can bootstrap a virgin store but can never
   overwrite administered data — eliminating the hazard structurally
   rather than by operator ceremony.
4. **Authoritative store** — the Configuration Store is the source of
   truth forever; the Administration Framework is its write channel; and
   the seed document format graduates into first-class ADMINISTERED
   import/export operations (audited, versioned, conflict-checked) — the
   framework owns the migration path, and git becomes an export target
   for review and backup, not a source of truth.

Steps 2–4 are future tickets; this ADR fixes the destination so the
interim env-var ceremony is never mistaken for the architecture.

## Consequences

- Firm configuration becomes administrable without commits, audited,
  versioned, and conflict-safe — the Administration Portal grows from
  this contract, and the Constitution's Principle 5 (behavior lives in
  configuration) gains its management surface.
- The minimal client (`admin/index.html`) is correctness-first; it
  inherits the guideherd.ai design language later (same direction as the
  Operations Center, ADR-0014 §6).
- Out of scope, recorded: billing, licensing, onboarding, analytics,
  multi-region sync, SCIM, public administration APIs, rollback UI.
