# GuideHerd Backend

Node.js services for GuideHerd. Zero runtime dependencies — Node built-ins only
(`node:http`, `node:crypto`, `node:test`), matching the repository's existing
scripts. Requires Node 20+ (developed on Node 22).

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

### Test

```bash
cd server
npm test           # node --test
```

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
