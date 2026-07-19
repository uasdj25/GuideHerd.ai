# ADR-0016: The GuideHerd Customer Configuration Framework

**Status:** Accepted — implemented and governing on `main`.
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principle 5 — behavior lives in
configuration), ADR-0004 (Configuration Store — the substrate), ADR-0015
(Administration — the first producer), ADR-0012/0011/0009/0005 (the
subsystems whose validators the registry composes)

## Context

Settings-backed configuration had scattered ownership: six consumers each
hand-rolled their own settings parsing, defaulting, and fail-safety
(scheduling policy, notification branding, notification enablement, and
three provider selections), while the Administration Framework duplicated
some of that validation at write time. Correctness lived in many places
with no single contract. This ADR establishes the permanent Customer
Configuration Contract: producers submit intent; the framework owns
correctness; consumers receive normalized configuration only.

## Decision

### 1. The domain contract

Every settings-backed domain registers ONCE
(`server/configuration/framework.js`): id, setting address, schema
version, an optional `migrate` hook, and a `normalize(raw, context)`
function — authored and owned by the consuming subsystem, composed by the
registry (`configuration/domains.js`). Six production domains exist:
scheduling-policy (scheduling), notification-branding, notifications,
notification-provider (notifications), identity-provider (identity),
conversation-provider (connect). Unknown domains fail loudly in both
directions.

**The registry is the single authoritative catalog of customer
configuration, enforced structurally:** a conformance test scans the
production source and fails the suite if any module outside the
sanctioned three (the Configuration Store's own internals, the
framework's read path, administration's snapshot reads) touches the
settings store directly — a developer cannot accidentally introduce an
unregistered settings domain without breaking CI. One domain per setting
address is enforced at registration. Entity domains cannot appear
accidentally either: they require store schema migrations and service
methods by construction.

Entity/catalog configuration (organization, attorneys, practice areas,
consultation types, routing groups, locations/hours) remains store-backed:
its schema and validation are the Configuration Store's normalizers
(ADR-0004), administered through ADR-0015's entity areas. Together the two
families are the complete domain model — all of it LIVE.

### 2. Producer/consumer asymmetry — one gate, one read path

- **Consumers** call `readDomain()`: raw setting → migrate → normalize →
  value, with defaults applied and malformed fields degraded WITHIN the
  domain (reported as issues, never thrown). Consumers never parse or
  validate; the six legacy resolvers are now exact delegations, proven by
  their untouched pinned tests.
- **Producers** call `validateDomain()`: migrate → normalize → REQUIRE
  zero issues → strict deployment cross-checks (e.g. an identity provider
  must be registered) → the CANONICAL normalized document, which is the
  only thing a producer may persist. Administration's setting areas are
  now GENERATED from this registry — administration cannot bypass the
  framework, carries no per-domain validation code, and a new domain
  registration is automatically administrable.
- **Bypass containment:** even a writer that skips the gate cannot poison
  consumers — the read path re-normalizes everything (tested), and the
  damage surfaces as issues rather than silent misbehavior. The producer
  gate guarantees clean data; the consumer floor guarantees safe behavior
  regardless.

### 3. Versioning and schema evolution — migration ownership

Optimistic concurrency and audit history ride ADR-0015's machinery
(monotonic per-entity versions, before/after snapshots, 409 on stale
writes). SCHEMA evolution is the framework's: a domain bumps its
`schemaVersion` and ships a `migrate(doc)` hook that upgrades any
historical shape — applied non-destructively on read and before write
validation, so old documents keep working and every new write persists
the current canonical shape (demonstrated in tests with a v1→v2
migration).

**Ownership boundary, permanent:** the FRAMEWORK owns migration
orchestration — when hooks run (always before normalization, on both
paths), the non-destructive-read guarantee, and canonical-shape
persistence; each DOMAIN owns its migration logic — the transformations
themselves, authored by the owning subsystem. Today a domain ships one
idempotent any-shape-to-current hook; when a domain accrues enough
history to need stepwise migrations, the contract grows to a
framework-SEQUENCED step chain (from/to pairs executed in order) — the
same ownership split, with sequencing explicitly on the framework side.

### 4. Extension model

A future configuration domain is one schema + one validator + one
registration. From that single registration: consumers read normalized
values, producers are strictly gated, administration gains the change
area, and versioning/audit apply — no Core change anywhere (proven in
tests end to end, including two provider-selection domains that became
administrable purely by being registered).

### 5. Live vs restart classification

**LIVE — everything customer-owned.** All six settings domains and all
six entity domains: consumers read per request. Restart-required
customer configuration is zero, by design.

**RESTART REQUIRED — deployment wiring and secrets, never customer
configuration** (unchanged from ADR-0015 §5): operational store provider,
console authentication floor, static identities/dev users, active
user-auth provider, session TTL, prepared-session cap default,
provider/extension registration, mail/bridge credentials, CORS origins.

### 6. Environment-variable trajectory

Legitimately environment forever: secrets and credentials (ADR-0007 §6 —
configuration data may never carry them), platform wiring
(`DATABASE_URL`, operational provider, port), and the security floor
(`GUIDEHERD_CONSOLE_AUTH` — configuration may only tighten it, per the
ADR-0013 ruling). Candidates to migrate into customer configuration as
tighten-only or per-organization domains when their workflows arrive:
the prepared-session cap (per-organization, at or below the deployment
default), user session TTL (tighten-only), and per-organization
user-auth provider selection (the identity-provider domain already
exists; the deployment env remains the platform default).

## Consequences

- Configuration correctness is defined once per domain and enforced for
  every producer and every consumer, present and future.
- Administration shrank: its per-domain validation code was deleted in
  favor of the registry, and it gained two new administrable areas for
  free.
- The framework is the natural home for the ADR-0015 §6 import/export
  operations when they arrive: an imported document is just another
  producer passing the same gate, domain by domain.
