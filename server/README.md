# GuideHerd Backend

Node.js services for GuideHerd. Zero runtime dependencies — Node built-ins only
(`node:http`, `node:crypto`, `node:test`), matching the repository's existing
scripts. Requires Node 20+ (developed on Node 22).

This directory is **not** part of the static website deploy.

## Context Handoff API (v1)

The first capability: it passes short-lived caller context from the (future)
Receptionist Portal to the Scheduling Assistant. Public contract and examples
are documented in [`docs/api/context-handoff.md`](../docs/api/context-handoff.md).

### Run

```bash
cd server
npm start          # binds 0.0.0.0 on PORT (default 3000)
```

Configuration (environment variables):

- `PORT` — listen port (default `3000`).
- `CORS_ALLOWED_ORIGINS` — comma-separated browser-origin allowlist (default
  `https://guideherd.ai,http://localhost:8080`). Wildcards are ignored; only
  `POST`/`OPTIONS` and the `Content-Type` header are allowed cross-origin.

### Test

```bash
cd server
npm test           # node --test
```

## Design notes

- **`handoff/`** — the Session/Handoff service, split into small modules:
  `models` (typedefs + limits), `validation`, `store` (in-memory), `service`
  (business logic), `app` (HTTP wiring), plus `clock`, `ids`, `status`,
  `errors`.
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
- **Tokens** are 256-bit, cryptographically random, prefixed `gh_handoff_`, and
  stored only as a SHA-256 hash. They are never logged or placed in URLs.

## Not in v1 (intentionally deferred)

No database, cache, queue, event bus, or microservices. **No authentication** —
that is a required production prerequisite (see the security note in
`server.js` and the API doc). No vendor integrations.
