# Deployment Reference — Environment Variables

**Internal operator documentation.** Not customer-facing and not published to
the customer documentation site.

The customer-facing counterpart is
[`docs/customer/installation-and-deployment.md`](../customer/installation-and-deployment.md),
which covers deployment *decisions* and verification without naming variables.
This page is the variable reference for whoever actually sets them.

Related: [Receptionist Console activation runbook](receptionist-console-activation.md).

---

## Core

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `CORS_ALLOWED_ORIGINS` | `https://guideherd.ai,http://localhost:8080` | Exact browser-origin allowlist. Wildcards ignored — this API never allows `*`. |
| `GUIDEHERD_CONFIG_DB` | `./guideherd-config.db` | Configuration store path. Migrations apply automatically at boot. |

A console that cannot reach the API is most often `CORS_ALLOWED_ORIGINS` — the
failure presents as a network problem rather than a configuration one.

---

## Operational store

| Variable | Default | Purpose |
|---|---|---|
| `GUIDEHERD_OPERATIONAL_PROVIDER` | `memory` | `memory` or `postgres` |
| `DATABASE_URL` | — | PostgreSQL connection string (Railway injects this) |
| `GUIDEHERD_OPERATIONAL_DATABASE_URL` | — | Alternative connection string; wins if both are set |
| `GUIDEHERD_PG_POOL_MAX` | `5` | Pool size **per instance** — keep the sum under the plan's connection limit |

**No silent fallback.** `postgres` with an unreachable database, a failed
migration, or no connection string makes the process **exit rather than start**;
an unknown value does the same. Rollback is `memory` plus a redeploy.

With `postgres`, handoff sessions, notification delivery records, the outbox,
and scheduled reminders are durable and survive restarts.

---

## Email delivery

All five must be present or the mailer stays disabled:

```
MS_TENANT_ID
MS_CLIENT_ID
MS_CLIENT_SECRET
SUMMARY_MAILBOX
SUMMARY_RECIPIENT
```

With any missing, the API starts normally and reports delivery as
`not-configured`. Booking and notification are separate outcomes by design — **a
mail failure never reverses a confirmed appointment.**

`NOTIFICATION_MAILBOX` overrides the sending mailbox (falls back to
`SUMMARY_MAILBOX`).

**Sender identity is a deployment concern.** A firm's configured sender name
appears in the subject and body; it does **not** change the From address. Email
from a firm's own domain requires a firm-specific mailbox here.

> **Check before assuming notifications work.** If these are unset, no email
> leaves the system — including consultation summaries — and the Operations
> Center reports every delivery as `not-configured`.

---

## Configuration seeding

| Variable | Default | Purpose |
|---|---|---|
| `GUIDEHERD_SEED_FILE` | unset | Seed document, applied per `GUIDEHERD_SEED_MODE` |
| `GUIDEHERD_SEED_MODE` | `bootstrap` | `bootstrap` = one-time import (skip once the organization exists); `always` = explicit every-boot re-import (`seed-managed`) |

**The persistent configuration store is the source of truth (ADR-0022).** In
the default `bootstrap` mode a seed file is a one-time import: once its
organization exists in the store, boot skips the import loudly and
administration edits win — a stale seed document can never overwrite them.
`GUIDEHERD_SEED_MODE=always` keeps the historical git-as-source-of-truth
behavior as an explicit opt-in: the document is re-imported at every boot, a
warning is logged, and the deployment reports `configuration-authority:
seed-managed` on the Operations Center health list and a warning banner on the
Administration screen. An unknown mode value refuses to start.

- **Persistent disk (volume) + `bootstrap`** → administration edits persist;
  the seed file (if still set) is inert after first import.
- **Ephemeral filesystem + seed file** → the store is empty at each boot, so
  even `bootstrap` re-imports each time; administration edits are temporary.
  Making them durable requires a volume — see
  [`configuration-authority-cutover.md`](configuration-authority-cutover.md).

An ephemeral filesystem with *no* seed file leaves a firm with no practice
areas, attorneys, or consultation types after a restart — every receptionist
sees the "couldn't load scheduling options" error.

Seed-file-only configuration (no administration path): consultation types,
routing groups and their practice-area assignments.

---

## Authentication

| Variable | Default | Purpose |
|---|---|---|
| `GUIDEHERD_CONSOLE_AUTH` | `anonymous` | `anonymous` or `required`. Any other value refuses to boot. |
| `GUIDEHERD_USER_AUTH_PROVIDER` | `dev-user` | Active user-auth provider |
| `GUIDEHERD_DEV_USERS` | — | JSON array of provisioned users |
| `GUIDEHERD_USER_SESSION_TTL_SECONDS` | `43200` (12h) | Absolute session lifetime, not sliding |

**Do not flip `GUIDEHERD_CONSOLE_AUTH` from this page.** Follow the
[activation runbook](receptionist-console-activation.md) — users must be
provisioned and individually verified first, and the rollback rehearsed.

**Login sessions are in memory.** A restart signs everyone out, and exactly one
API instance is required. See the runbook's session-store operating boundary.

---

## Other

| Variable | Default | Purpose |
|---|---|---|
| `GUIDEHERD_MAX_PREPARED_SESSIONS` | `20` | Concurrent prepared sessions per firm; exceeding returns `429` |
| `GUIDEHERD_OUTBOX_POLL_INTERVAL_MS` | — | Drain interval for queued work |
| `DEMO_BRIDGE_SECRET` | — | Demo infrastructure only. **Not production authentication.** |
| `GUIDEHERD_TEST_DATABASE_URL` | — | Test-only; enables the PostgreSQL leg of the backend suite |

---

## Current production configuration

Recorded from a read-only inspection on **2026-07-18**. Re-verify before relying
on it.

| Setting | Value |
|---|---|
| Replicas | **1** (region `sfo`) |
| `GUIDEHERD_OPERATIONAL_PROVIDER` | `postgres` — operational data is durable |
| `GUIDEHERD_CONSOLE_AUTH` | unset → `anonymous` |
| `GUIDEHERD_SEED_FILE` | **set** → seed applied per `GUIDEHERD_SEED_MODE` |
| `GUIDEHERD_SEED_MODE` | unset (pre-cutover this meant every-boot re-import; after ADR-0022 ships, unset = `bootstrap`) |
| `MS_*` / `SUMMARY_*` | **unset** → email delivery disabled |

Two of these deserve attention:

1. **The configuration store lives on an ephemeral filesystem** (no volume
   attached), so administration changes still do not survive a restart in
   production today — even in `bootstrap` mode, because the store itself is
   wiped. The cutover runbook
   ([`configuration-authority-cutover.md`](configuration-authority-cutover.md))
   attaches a volume and completes the switch; until it is executed, the
   deployment re-imports at every boot and reports
   `configuration-authority: bootstrap-imported` (a warning that never
   clears to `live`, because no restart ever finds a populated store).
2. **No mail credentials are configured**, so no notification — including the
   consultation summary — is being delivered.
