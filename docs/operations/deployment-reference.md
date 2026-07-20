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

## Health probes (#38)

| Route | Auth | Meaning |
|---|---|---|
| `GET /healthz` | none | Liveness: the process serves HTTP. Checks nothing else, by design. |
| `GET /readyz` | none | Readiness: `200 {"status":"ready"}` when the operational and configuration stores answer within a bounded timeout; `503` otherwise. One word, no detail. |
| `GET /api/v1/operations/health` | session + `operations:read` | The full capability report (ADR-0014): overall `status` (`healthy`/`degraded`/`unavailable`), `checkedAt`, per-capability list. |

Recommended platform healthcheck target: **`/readyz`** (Railway:
`healthcheckPath`). Point uptime monitors at `/healthz` (a database blip
should page as degraded, not restart the process). Setting the Railway
healthcheck path is a production change — do it deliberately, not as part of
a deploy.

## Other

| Variable | Default | Purpose |
|---|---|---|
| `GUIDEHERD_MAX_PREPARED_SESSIONS` | `20` | Concurrent prepared sessions per firm; exceeding returns `429` |
| `GUIDEHERD_TRUST_PROXY` | unset (off) | Trust `X-Forwarded-For` (rightmost entry) for login rate-limiting. **Leave UNSET on Railway.** Railway's official docs do not document `X-Forwarded-For` behavior at all (they document `X-Real-IP` as the client-IP header), and Railway staff statements contradict each other on append-vs-strip and leftmost-vs-rightmost — so the rightmost-XFF model is **not proven correct on Railway** and must not be relied on. Unset is fail-safe: XFF is ignored, all clients behind the edge share one limiter key (coarser throttling, never spoofable). Only enable behind an edge whose XFF-append semantics you have positively verified. A proper per-client limiter on Railway would key on `X-Real-IP` — a future change, gated on verifying that header (it has documented caveats under Railway's CDN path). |
| `GUIDEHERD_OUTBOX_POLL_INTERVAL_MS` | — | Drain interval for queued work |
| `DEMO_BRIDGE_SECRET` | — | Demo infrastructure only. **Not production authentication.** |
| `GUIDEHERD_TEST_DATABASE_URL` | — | Test-only; enables the PostgreSQL leg of the backend suite |

---

## Data retention (ADR-0006 / #63)

Automated retention ships and runs on the liveness poller, but it is
**OFF BY DEFAULT and never deletes anything until an organization
explicitly opts in.** To enable it for a firm, set the `data-retention`
domain to `{ "enabled": true }` (optionally with `cancelledExpiredHours` /
`terminalDays` overrides). While disabled — the default — the Operations
Center health reports `data-retention: not-configured` and no row is ever
purged.

When enabled, the sweep hard-deletes cancelled/expired handoff sessions
after `cancelledExpiredHours` (suggested **24h**) and terminal sessions
after `terminalDays` (suggested **30 days**), per organization. The
delivered consultation summary email is the durable record; rendered
summaries are never stored.

The suggested WINDOWS remain **proposed pending sign-off** (ADR-0006).
Enabling retention and confirming the numbers are deliberate human
decisions.

### Interim manual procedure (for pre-existing data / until window sign-off)

Owner: whoever administers the operational database. Cadence: weekly during
the pilot, or on request. Exact statements (parameterize the cutoffs; run
against the operational PostgreSQL only, never printing caller data):

```sql
-- cancelled/expired older than 24h
DELETE FROM handoff_sessions
 WHERE organization_key = :org
   AND ( (status = 'cancelled' AND COALESCE(cancelled_at, expires_at) <= now() - interval '24 hours')
      OR (status IN ('expired','awaiting-transfer') AND expires_at <= now() - interval '24 hours') );
-- terminal older than 30 days
DELETE FROM handoff_sessions
 WHERE organization_key = :org
   AND status IN ('booked','failed','escalated')
   AND completed_at IS NOT NULL AND completed_at <= now() - interval '30 days';
```

Record: date, organization, row counts (never caller details). Once the
automated sweep is confirmed running (via the `retention.swept` telemetry
and stable row counts), the manual procedure is a fallback only.

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
