# ADR-0022: Configuration Authority

**Status:** Proposed — implemented locally (GitLab #59); production cutover pending
**Date:** 2026-07-19
**Relates to:** GuideHerd Constitution (Principles: fail loud, no silent
behavior), ADR-0004 (Configuration Store), ADR-0014 (Operations Center),
ADR-0015 (Administration Framework), ADR-0016 (Customer Configuration
Framework)

## Context

The Configuration Store began as a git-seeded artifact: deployments with an
ephemeral filesystem set `GUIDEHERD_SEED_FILE` and the seed document was
re-imported at every boot. `server.js` carried an explicit warning that this
mode "MUST NOT be enabled once a firm's configuration is edited through a live
channel a git deploy doesn't know about." The Administration Framework
(ADR-0015) is now that channel and is in production use — so every
administration change in production is **silently reverted at the next
restart or deploy**, and nothing tells an administrator which mode a
deployment is in. That is exactly the class of silent behavior the
Constitution forbids.

## Decision

**The persistent configuration store, written through the Administration
Framework, is the authoritative source of configuration. A seed document is a
one-time bootstrap input, never a recurring overwrite — unless a deployment
explicitly, loudly opts into recurring re-import.**

1. **`GUIDEHERD_SEED_MODE`** — `bootstrap` (default) | `always`. Any other
   value refuses to start.
   - `bootstrap`: at boot, the seed document is imported **only when its
     organization does not exist** in the store. Once present, boot skips the
     import with a loud structured log line naming the organization; live
     configuration wins, and a stale seed file can never overwrite newer
     administration edits. The skip test is per organization key, so a second
     firm's document bootstraps normally alongside an existing firm
     (multi-tenant safe).
   - `always`: the historical every-boot re-import, retained for demos and
     deliberately git-managed deployments — now explicit, warned at every
     boot, and visible on every operator/administrator surface.
2. **Failure handling is unchanged and extended**: an unreadable or invalid
   document — or an unknown mode value — exits non-zero before binding the
   port. `importOrganization` validates the entire document before one
   transaction, so a crash mid-import leaves the store untouched.
3. **The intentional re-import path** for a live store is the operator CLI
   (`npm run config:seed`), run deliberately — never startup.
4. **Authority is visible and evidence-based.** A `configurationAuthority`
   descriptor `{ mode, seedOnBoot, lastBootImport }` is computed at boot and
   surfaced on the Operations Center capability list
   (`configuration-authority`) and in Administration `describe()` (rendered
   as a banner on the Administration screen). Three states:
   - `seed-managed` — `always` mode; edits are overwritten (warning).
   - `bootstrap-imported` — `bootstrap` mode imported *this* boot. A first
     boot on durable storage and an every-boot import on an ephemeral
     filesystem are indistinguishable from inside a single boot, so this
     state deliberately promises nothing; the restart that finds the store
     populated and skips is what proves durability (warning until then).
   - `live` — the store pre-existed this boot; administration writes are
     authoritative (ok).

## Consequences

- An administration change survives restarts and deploys on any deployment
  whose banner reads `live` — and only a deployment whose banner reads
  `live`, which administrators can see without asking support.
- A fresh deployment still bootstraps from a seed document exactly once;
  the variable may stay set indefinitely without harm in `bootstrap` mode.
- No silent overwrite path remains: `always` is opt-in, warned at each
  boot, and badged on both product surfaces.
- Production cutover (attach a durable volume for the configuration store,
  bootstrap once, verify the badge transitions `bootstrap-imported → live`
  across a restart, confirm an edit survives) is an operations action
  documented in `docs/operations/configuration-authority-cutover.md`; this
  ADR moves to Accepted when it has been executed.
- Rollback is configuration-only: modes destroy no data, and reverting to
  `always` is one variable change.
