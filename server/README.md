# GuideHerd Backend

Node.js services for GuideHerd. Zero runtime dependencies — Node built-ins only
(`node:http`, `node:crypto`, `node:sqlite`, `node:test`), matching the
repository's existing scripts. Requires Node 22.5+ (`node:sqlite`; the npm
scripts pass `--experimental-sqlite`, needed below Node 22.13 / 23.4 and
accepted harmlessly above).

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

### Test

```bash
cd server
npm test           # node --test
```

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
- **Storage is in-memory** behind a small `create / redeem / get` interface, so a
  persistent store can replace it later without touching the service or routes.
- **Single-use redemption** relies on Node's single-threaded event loop: the
  store's `redeem()` does its check-and-mark in one synchronous pass with no
  `await` in the middle, so concurrent requests cannot both succeed. Exactly one
  wins; the rest get `409 Conflict`.
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

- Sessions are **in-memory only**: lost on restart/deploy; single instance
  required.
- **No authentication for creating sessions**, and the receptionist page is
  not authenticated — both required before production (see `server.js`).
- A browser refresh loses the console's active session state.
- The demo bridge is temporary: no phone transfer occurs, selection requires
  exactly one eligible prepared session, and direct calendar-webhook
  confirmation remains deferred hardening.
- No database, cache, queue, event bus, microservices, telephony, or vendor
  integrations.
