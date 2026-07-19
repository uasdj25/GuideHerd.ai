# GuideHerd Backend

Node.js services for GuideHerd. Node built-ins (`node:http`, `node:crypto`,
`node:sqlite`, `node:test`) plus **exactly one runtime dependency**: the
pinned `pg` PostgreSQL driver for the Operational Store — the deliberate,
documented exception to the zero-runtime-dependency preference (ADR-0006;
hand-rolling the PostgreSQL wire protocol would be unsafe database code).
Requires Node 22.5+ (`node:sqlite`; the npm scripts pass
`--experimental-sqlite`, needed below Node 22.13 / 23.4 and accepted
harmlessly above). Run `npm install` once in `server/` to fetch `pg`.

This directory is **not** part of the static website deploy.

## Context Handoff API (v1)

The first capability: it passes short-lived caller context from the (future)
GuideHerd Console to the Scheduling Assistant. Public contract and examples
are documented in [`docs/api/context-handoff.md`](../docs/api/context-handoff.md).

### Run

```bash
cd server
npm start          # binds 0.0.0.0 on PORT (default 3000)
```

Local console development: serve the site on `http://localhost:8080` and open
`/receptionist/?apiBase=http://localhost:3000`. The console honors the
`apiBase` override **only when the page itself runs on localhost/127.0.0.1**,
and only for `http://localhost:<port>` / `http://127.0.0.1:<port>` targets; on
any other host it always uses `https://api.guideherd.ai`.

Configuration (environment variables):

- `PORT` — listen port (default `3000`).
- `CORS_ALLOWED_ORIGINS` — comma-separated browser-origin allowlist (default
  `https://guideherd.ai,http://localhost:8080`). Wildcards are ignored; only
  `POST`/`GET`/`DELETE`/`OPTIONS` and the `Content-Type` and `Authorization`
  headers are allowed cross-origin. Demo bridge endpoints are never granted
  browser CORS.
- `DEMO_BRIDGE_SECRET` — TEMPORARY demo infrastructure: authorizes the
  server-to-server demo bridge (`/api/v1/demo/*`, see
  `docs/api/demo-bridge.md`). Unset ⇒ those endpoints return a controlled
  `503`. This shared secret is **not** production authentication.
- `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `SUMMARY_MAILBOX`,
  `SUMMARY_RECIPIENT` — Microsoft Graph delivery of the GuideHerd Consultation
  Summary. All five must be present or the mailer is disabled and outcome
  calls report `summaryDelivery: "not-configured"`; the API starts and tests
  run without any of them. Delivery is a separate outcome from booking — a
  mail failure never reverses a confirmed appointment.
- `GUIDEHERD_CONFIG_DB` — path to the Configuration Store SQLite file
  (default `./guideherd-config.db`). Pending migrations apply automatically
  at boot regardless of this setting.
- `GUIDEHERD_SEED_FILE` — **optional**, off by default. See "Configuration
  Store deployment modes" below.
- `GUIDEHERD_OPERATIONAL_PROVIDER` — Operational Store selection (ADR-0006):
  `memory` (default — sessions in process memory, exactly the pre-existing
  behavior) or `postgres` (durable sessions). Selecting `postgres` with an
  unreachable database, a failed migration, or no connection string makes
  the process **exit non-zero instead of starting**; an unknown value does
  the same. There is never a silent fallback. **Rollback = set it back to
  `memory` and redeploy.**
- `DATABASE_URL` / `GUIDEHERD_OPERATIONAL_DATABASE_URL` — PostgreSQL
  connection string for the Operational Store (the second wins when both are
  set; Railway injects the first when a PostgreSQL service is linked). Used
  only when the provider is `postgres`.
- `GUIDEHERD_PG_POOL_MAX` — operational connection-pool size per instance
  (default `5`; keep the sum across instances under the database plan's
  connection limit).

### Test

```bash
cd server
npm test           # node --test — includes the repository contract suite
                   # against the in-memory store; the PostgreSQL leg skips
                   # (loudly) unless a test database is provided:
GUIDEHERD_TEST_DATABASE_URL=postgresql://user@host:5432/disposable_db npm test
```

The PostgreSQL test leg drops and recreates its tables — point it only at a
**disposable** database, never at real data.

```bash
npm run test:pg    # the same full suite, PostgreSQL leg included, against a
                   # REAL disposable embedded PostgreSQL — no system install
```

`test:pg` boots an embedded PostgreSQL (devDependency `embedded-postgres`,
exact-pinned; real server binaries confined to node_modules) in a temporary
data directory on a free 127.0.0.1 port with a random process-local
credential, runs the complete suite through the project's real migration
path, then always stops the server and removes the temporary state — on
success, failure, interruption, or timeout. Nothing about it is reachable
from production composition, and no credential or connection string is ever
printed. Use it locally where no PostgreSQL exists; CI can keep supplying
`GUIDEHERD_TEST_DATABASE_URL` instead.

Dependency review (recorded 2026-07-18, retained): `embedded-postgres` is
MIT-licensed, maintained by Lei Nelissen (leinelissen/embedded-postgres on
GitHub; actively published). Real PostgreSQL binaries are BUNDLED inside
per-platform npm packages (no download-at-install), selected via
optionalDependencies covering darwin arm64/x64, linux x64/arm64/arm/ia32/
ppc64, and windows x64 — macOS ARM64 development and Linux CI both work.
The only install hook is the platform package's `postinstall`
symlink-rehydration script, which reads a bundled manifest and creates
package-internal symlinks only (inspected; no network, no writes outside
its own directory). Transitive runtime deps: `pg` (already a project
dependency) and `async-exit-hook` (tiny, zero-dep). Versioning caveat: the
package publishes no untagged-stable releases (major.minor tracks the real
PostgreSQL version; the suffix tracks wrapper maturity) — acceptable for
an exact-pinned dev-only harness. Preferred over a CI-service-container-
only approach because it gives developers a real local PostgreSQL leg with
zero system software, while CI remains free to supply
`GUIDEHERD_TEST_DATABASE_URL` from a service container — the two paths
share the same suite.

## Operational Store

`operational/` is the durable home of operational conversation state
([ADR-0006](../docs/architecture-decisions/ADR-0006-operational-store-postgresql.md)),
Phase 1: handoff sessions in PostgreSQL. The Handoff repository contract is
async with two implementations — the in-memory reference in
`handoff/store.js` (default; powers tests and the current live demo) and the
PostgreSQL repository in `operational/session-repository.js`. A shared
contract suite (`operational/contract-suite.js`) runs against both, so they
cannot drift apart. State-machine semantics are identical; atomicity comes
from conditional updates and `SELECT … FOR UPDATE` transactions instead of
single-threaded execution, which is what makes multiple API instances safe.

- `db.js` — pooled connections (`pg`, pinned; see the dependency note above).
- `migrate.js` + `migrations/NNNN-*.sql` — the same numbered-SQL pattern as
  the Configuration Store, applied transactionally at boot under a
  `pg_advisory_lock` so concurrently booting instances serialize.
  Migrations are **additive-only** (deploys overlap old and new instances).
- Deployment cutover: attach a managed PostgreSQL service (Railway injects
  `DATABASE_URL`), deploy with `GUIDEHERD_OPERATIONAL_PROVIDER` unset
  (memory — nothing changes), then set it to `postgres` and redeploy.
  Rollback is setting it back to `memory`.
- Retention: proposed defaults live in ADR-0006; the automated purge job is
  a follow-on ticket. A controlled low-volume pilot may run under an
  explicitly documented **manual** retention/deletion policy; automated
  retention is required before broader production scale.

## Configuration Store

`config/` is the GuideHerd Configuration Store (see
[ADR-0004](../docs/architecture-decisions/ADR-0004-embedded-configuration-store.md)
and issue #26): an embedded SQLite database for per-customer configuration —
organizations (firms), providers (attorneys), service areas (practice areas),
consultation types, routing groups, locations, office hours, and namespaced
JSON settings.

It is a **sibling of `handoff/` with no imports in either direction** and no
HTTP surface yet: a library (`config/service.js`) plus a seed CLI. It stores
configuration only — clients, sessions, appointments, and other operational
data are excluded by design (future Operational Store).

```bash
cd server
npm run config:seed -- --db guideherd-config.db --file config/data/martinson-beason.example.json
```

The seed command applies pending migrations
(`config/migrations/NNNN-*.sql`, recorded in `schema_migrations`) and then
upserts the organization document by key — non-destructive and safe to
re-run. `service.exportOrganization(key)` produces the same document shape
back. Backup is a file copy of the `.db` (WAL mode; use `VACUUM INTO` for a
consistent snapshot of a live database). Local databases are gitignored.

Module layout mirrors `handoff/`: `models` (typedefs + limits),
`validation`, `store` (the only module containing SQL), `service` (business
logic), plus `db`, `migrate`, `clock`, `errors`, and `seed` (CLI + the
`loadSeedDocument` helper `server.js` also uses — see below). Entities are
addressed by stable kebab-case keys (e.g. `clay-martinson`,
`initial-consultation`) scoped to an organization key; integer row ids never
leave the store layer.

### Configuration Store deployment modes

The Configuration Store is a **file**, not a service — nothing separate runs.
How that file gets populated depends on where it's deployed:

- **Persistent disk** (e.g. this host's own filesystem, or a Railway volume):
  seed once with the CLI above; the file survives restarts and deploys.
  `GUIDEHERD_SEED_FILE` stays unset.
- **Ephemeral filesystem, no volume** (e.g. Railway without one attached):
  the file is wiped on every deploy, so it must be rebuilt at every boot.
  Set `GUIDEHERD_SEED_FILE=config/data/martinson-beason.example.json` (or a
  real firm's document) and `server.js` imports it automatically before
  accepting traffic — **git is the source of truth** in this mode. The
  import is an idempotent upsert (safe on every boot), and a malformed or
  invalid seed document makes the process **exit immediately with a
  non-zero code** rather than start serving an incomplete configuration —
  this is deliberate, so a bad deploy fails loudly (visible as a
  crash/restart in platform logs) instead of quietly breaking the console.

  **Do not enable this mode once a firm's configuration can be edited
  through a live channel a git deploy doesn't know about** (e.g. a future
  Administration Portal) — the next deploy's re-import would silently
  overwrite those edits with whatever's in git. Until such a channel
  exists, git-as-source-of-truth is the intended and only mode.

## GuideHerd Connect

`connect/` is the provider-neutral conversation layer (see
[ADR-0005](../docs/architecture-decisions/ADR-0005-guideherd-connect-conversation-layer.md)).
GuideHerd owns conversation state — prepared-session correlation, lifecycle,
outcomes, Consultation Summary delivery, provider configuration, and
conversation events. External providers own the phone call itself (audio,
telephony, media transport); Connect never proxies audio and never speaks
SIP/RTP.

- `adapter.js` — the Conversation Adapter contract and registry. One adapter
  per provider translates that provider's request dialect into GuideHerd's
  canonical contracts; validation is shared and can never be loosened per
  provider.
- `elevenlabs-adapter.js` — the first adapter; wraps the live integration's
  dialect (ignored connect body; flat outcome format) without changing it.
- `conversations.js` — the conversation service (connect/complete lifecycle,
  event emission). v1 keeps conversation state on the handoff session — one
  source of truth until the Operational Store exists.
- `events.js` — conversation events (`conversation.connected`,
  `conversation.completed`): identifiers and transition facts only, never
  tokens, provider payloads, or caller contact details. No production
  subscribers in v1; this is the seam future capabilities attach to.
- `provider-config.js` — per-firm provider selection from the Configuration
  Store setting `connect/conversation-provider` (default: `elevenlabs`).
  An explicitly configured but unregistered provider fails loudly with
  `503 conversation_provider_unavailable`. Secrets never live in settings.

Import direction: `connect/` may import from `handoff/` and read from
`config/`; neither imports back. The temporary demo-bridge routes now
delegate to Connect — when trusted telephony delivery replaces the bridge,
the routes are removed and Connect remains.

## Design notes

- **`handoff/`** — the Session/Handoff service, split into small modules:
  `models` (typedefs + limits), `validation`, `store` (in-memory), `service`
  (business logic), `app` (HTTP wiring), plus `clock`, `ids`, `status`,
  `errors`. Slice 3 adds:
  - `summary.js` — the GuideHerd Consultation Summary: structured domain model
    built from trusted session context + validated outcome, with HTML
    rendering kept separate (PDF rendering deferred).
  - `mailer.js` — GuideHerd mailer boundary over Microsoft Graph
    (client-credentials, native `fetch`, zero dependencies).
  - `demo-bridge.js` — **TEMPORARY DEMO INFRASTRUCTURE**: server-held connect
    (`POST /api/v1/demo/connect`, requires exactly one eligible prepared
    session) and the GuideHerd-owned outcome contract
    (`POST /api/v1/demo/outcome`). Remove when production telephony delivery
    of the handoff token lands.
- **Storage sits behind the async Handoff repository contract** (ADR-0006):
  in-memory by default, PostgreSQL when selected — services and routes are
  implementation-blind.
- **Single-use redemption** is atomic in both implementations: the in-memory
  store does its check-and-mark in one synchronous pass (Node never preempts
  synchronous code); the PostgreSQL store uses a single conditional
  `UPDATE … RETURNING`. Exactly one concurrent redeemer wins; the rest get
  `409 Conflict` — across any number of API instances.
- **Expiration is lazy** — sessions are marked `expired` when accessed. There is
  no background scheduler in v1.
- **Deterministic time** — a `clock` abstraction is injected so expiration is
  tested with a fake clock, never with sleeps.
- **Tokens** are 256-bit, cryptographically random, and stored only as SHA-256
  hashes. They are never logged or placed in URLs. Each session issues two
  distinct credentials:
  - `gh_handoff_…` — voice-side token; redeems caller context exactly once.
  - `gh_console_…` — GuideHerd Console token; authorizes only
    `GET /api/v1/handoffs/{sessionId}` (status) and
    `DELETE /api/v1/handoffs/{sessionId}` (cancel), via
    `Authorization: Bearer`. It can never redeem caller context, and the
    handoff token can never check status or cancel.
- **Cancellation** is atomic with redemption (same synchronous check-and-mark
  discipline): a concurrent cancel/redeem race settles into exactly one
  terminal state. Repeat cancels are idempotent.
- The future telephony integration will receive the handoff token through a
  trusted GuideHerd handoff mechanism; the browser holds it in memory only as
  an interim measure for this slice.

## Not yet in place (pilot prerequisites, stated plainly)

- Sessions are in-memory **by default** (the live demo's mode): lost on
  restart/deploy, single instance required. Durable multi-instance sessions
  exist behind `GUIDEHERD_OPERATIONAL_PROVIDER=postgres` but are not yet
  enabled in any deployment, and the retention/purge job is not built.
- **No authentication for creating sessions**, and the receptionist page is
  not authenticated — both required before production (see `server.js`).
- A browser refresh loses the console's active session state.
- The demo bridge is temporary: no phone transfer occurs, selection requires
  exactly one eligible prepared session, and direct calendar-webhook
  confirmation remains deferred hardening.
- No database, cache, queue, event bus, microservices, telephony, or vendor
  integrations.
