# ADR-0006: Operational Store — Durable Handoff State in PostgreSQL

**Status:** Proposed
**Date:** 2026-07-17
**Relates to:** Operational Store Phase 1; ADR-0002 (session-based handoffs),
ADR-0004 (embedded configuration store), ADR-0005 (GuideHerd Connect)

## Context

All operational conversation state — prepared handoff sessions, their state
transitions, recorded outcomes, and Consultation Summary delivery status —
lived in process memory. That was correct for the controlled demonstration
and wrong for production: it cannot survive a restart or deploy, cannot be
shared by multiple API instances, and cannot support multiple simultaneous
receptionists, durable outcomes, retries, or tenant-aware operational
history. Configuration (ADR-0004) is rebuildable from git; a caller's
booking is not.

## Decision

1. **PostgreSQL is the operational datastore.** Operational state needs
   exactly the primitives PostgreSQL provides: transactions,
   `SELECT … FOR UPDATE`, conditional `UPDATE … RETURNING`, advisory locks,
   transactional DDL, and a managed offering on the deployment platform.
   SQLite remains correct for the Configuration Store and wrong here — it is
   single-node file storage, and API instances do not share a filesystem.

2. **An async repository contract with two implementations.** The Handoff
   store interface became the repository contract (now async end to end).
   The in-memory implementation remains the reference and the default; the
   PostgreSQL implementation (`server/operational/session-repository.js`)
   mirrors it transition for transition. A shared contract test suite runs
   against both, so the implementations cannot drift apart silently.

3. **Atomicity moves from "single synchronous thread" to the database.**
   Each state-machine guarantee maps to an explicit mechanism:
   single-use redemption and the summary-delivery claim are single
   conditional `UPDATE … WHERE status/… RETURNING` statements; exactly-one-
   eligible connect, cancel-versus-connect, and first-terminal-outcome-wins
   run in transactions over `SELECT … FOR UPDATE` row locks. Losers
   re-evaluate against committed state and produce the same domain errors as
   before. Expiry stays lazy. Every timestamp is a bind parameter from the
   injected clock (never SQL `now()`), preserving deterministic tests.

4. **Explicit provider selection; never a silent fallback.**
   `GUIDEHERD_OPERATIONAL_PROVIDER` selects `memory` (default — exactly the
   pre-existing behavior) or `postgres`. Selecting `postgres` with an
   unreachable database or failed migration refuses to start; an unknown
   value refuses to start. Rollback is setting the variable back to
   `memory`. Merging PostgreSQL support therefore changes nothing about the
   live demonstration until the variable is flipped deliberately.

5. **One table in Phase 1.** `handoff_sessions` persists the current
   session model with the outcome and summary-delivery state folded in
   (they are 1:1 with the session today). Conversation records (ADR-0005's
   migration path), separate outcome/delivery tables, operational events,
   retention jobs, and metering are explicitly deferred. Multi-tenancy:
   every row carries `organization_key` (the stable public key — never the
   Configuration Store's internal row ids; the stores share no database and
   no foreign keys), and every query is tenant-scoped.

6. **The `pg` driver is the one deliberate runtime dependency.** The server
   keeps its zero-runtime-dependency preference, and this ADR records the
   exception: hand-rolling the PostgreSQL wire protocol is precisely the
   unsafe database code the rule exists to prevent. The version is pinned;
   no ORM and no migration framework are added — migrations reuse the
   in-repo numbered-SQL pattern (from `config/`), applied transactionally
   under a `pg_advisory_lock` so concurrently booting instances serialize.

7. **Migrations are additive-only.** The deployment platform overlaps old
   and new instances during a deploy, so the previous release must keep
   working against the migrated schema.

8. **What is never stored:** raw tokens (SHA-256 hashes only), bridge or
   provider secrets, provider credentials, raw webhook payloads,
   transcripts, recordings, or legal matter narratives. The outcome
   contract's strict allowlist enforces this at the API edge; tests scan
   persisted rows to prove it.

9. **A stuck delivery claim self-heals.** A `pending` summary-delivery
   claim older than five minutes is considered abandoned (the claimant
   crashed mid-send) and may be re-claimed — trading a rare duplicate email
   after a crash for retries that can never be permanently wedged. `sent`
   is final and never re-claimed.

## Retention (policy to confirm before production data)

Proposed defaults, pending sign-off: cancelled/expired sessions purge after
24 hours; terminal sessions retain caller contact details for 30 days
(organization-overridable), after which rows hard-delete. The delivered
summary email is the durable artifact of record; rendered summaries are
never stored. Backups retain purged data for the backup window.

The automated purge job is deferred to a follow-on ticket. Until it ships,
retention is manual: a **controlled low-volume pilot may proceed under an
explicitly documented manual retention/deletion policy** (who deletes, how
often, and the SQL used — recorded alongside the deployment runbook).
Automated retention remains **required before broader production scale**.

## Consequences

- Sessions, outcomes, and delivery state survive restarts and deploys, and
  any API instance can serve any request — with the same guarantees the
  single-process store enforced, now across instances.
- The repository contract is async; internal consumers (`service`,
  `demo-bridge`, Connect's conversation service) await it. Public HTTP
  contracts are unchanged.
- Local development and CI need a disposable PostgreSQL to run the durable
  test leg (`GUIDEHERD_TEST_DATABASE_URL`); without one, that leg skips
  loudly and the in-memory contract leg still runs.
- The deployment platform needs a managed PostgreSQL service attached
  (`DATABASE_URL`) before `GUIDEHERD_OPERATIONAL_PROVIDER=postgres` is set.
- Organization keys are append-only by convention: operational rows outlive
  configuration re-seeds and must keep meaning.
