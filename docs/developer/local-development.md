# Local Development

Everything here is runnable from a fresh clone. Node 22.5+ is required
(`node:sqlite`; the npm scripts pass `--experimental-sqlite`, which is needed
below Node 22.13 / 23.4 and harmless above).

## Running the server

```bash
cd server
npm install        # once; fetches the single runtime dependency (pinned pg)
npm start          # binds 0.0.0.0 on PORT (default 3000)
```

`npm start` runs `node --experimental-sqlite server.js`. Boot applies pending
Configuration Store migrations automatically, then fails fast (non-zero exit,
port never bound) on: a malformed seed document, an unknown
`GUIDEHERD_OPERATIONAL_PROVIDER` value, or `postgres` selected with an
unreachable database / failed migration. Environment variables are documented
in `server/README.md` (names only; never commit values). The console honors
`?apiBase=http://localhost:3000` only when the page itself is served from
localhost — serve the repo root on `http://localhost:8080` and open
`/receptionist/?apiBase=http://localhost:3000`.

## Configuration Store seeding modes

The Configuration Store is a SQLite **file** (default `./guideherd-config.db`,
override with `GUIDEHERD_CONFIG_DB`). Two population modes
(`server/README.md`, "Configuration Store deployment modes"):

- **Persistent disk** — seed once with the CLI; `GUIDEHERD_SEED_FILE` unset:

  ```bash
  cd server
  npm run config:seed -- --db guideherd-config.db --file config/data/martinson-beason.example.json
  ```

  The seed applies pending migrations and upserts the organization document by
  key — non-destructive, safe to re-run.

- **Ephemeral filesystem** — set `GUIDEHERD_SEED_FILE` to a config document
  path and `server.js` imports it on every boot (git is the source of truth).
  A malformed document makes the process exit non-zero rather than serve an
  incomplete configuration. Do not enable this once configuration is edited
  through a live channel (the Administration area writes to the same store);
  the next boot's re-import would overwrite those edits.

## Backend tests

```bash
cd server
npm test           # node --test — the full suite against in-memory stores.
                   # The PostgreSQL legs SKIP LOUDLY (a visible skipped test
                   # naming the variable), by design.
```

Three ways to run the PostgreSQL legs — all execute the *same* contract
suites (`server/operational/contract-suite.js` and friends):

```bash
# 1. Zero system software: a real, disposable, embedded PostgreSQL
#    (devDependency `embedded-postgres`, exact-pinned). Temp data dir,
#    127.0.0.1, random process-local credential that is never printed.
npm run test:pg    # wraps server/scripts/test-pg.js

# 2. Your own DISPOSABLE database (the suite drops and recreates tables —
#    never point it at real data). This is what test:pg sets for its child.
GUIDEHERD_TEST_DATABASE_URL=postgresql://user@host:5432/disposable_db npm test
```

`npm test` stays fast and PostgreSQL-free; the PG leg is opt-in via
`GUIDEHERD_TEST_DATABASE_URL`, and `test:pg` is the same opt-in with the
database supplied for you. See testing-standards.md for how to *add* a
PG-leg test.

## Frontend (browser) suites

`tests/frontend/` drives the real console pages in a real Chromium via
`playwright-core`, with **all API traffic mocked by request interception** —
no production calls. `playwright-core` does not download browsers; you must
point the suite at a Chromium binary:

- `CHROMIUM_PATH` — absolute path to a Chromium/Chrome executable, or
- `PLAYWRIGHT_BROWSERS_PATH` — a Playwright-managed browsers directory
  (the resolver also checks `/opt/pw-browsers`).

Reproducible commands:

```bash
cd tests/frontend
npm install --no-audit --no-fund
CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node console.test.js
CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node admin.test.js
```

(Use any local Chromium path; the macOS Chrome path above is one example.)
Note: `npm test` in `tests/frontend` runs **only** `console.test.js`
(`tests/frontend/package.json`); `admin.test.js` — the Administration Center
suite — is run directly as above. From `server/` there is a convenience
script, `npm run test:frontend`, which installs and runs the frontend
package's `test` script (again: console suite only).

Both suites serve the repo's static pages from a local `node:http` server and
intercept `https://api.guideherd.ai/**`. The mocks must mirror the real
server's CORS and response shapes — see the mock-fidelity rule in
testing-standards.md.

## End-to-end suite

`tests/e2e/console-auth.e2e.js` is a single-process e2e: the **real**
`createApp()` (with `GUIDEHERD_CONSOLE_AUTH=required`, a local non-production
dev user, and a throwaway seeded Configuration Store) plus a real browser
driving the real console — no mocks, no interception. It requires the
frontend suite's `node_modules` (it loads `playwright-core` from
`tests/frontend/node_modules`) and the same Chromium resolution:

```bash
cd tests/frontend && npm install --no-audit --no-fund && cd ..
CHROMIUM_PATH=/path/to/chromium node e2e/console-auth.e2e.js
```

It covers the auth gate, login, session restoration across reload,
authenticated handoff creation, mid-workflow expiry, logout, and the
anonymous-floor rollback.

## What CI runs

- `.github/workflows/deploy.yml` — the static-site deploy: on push to `main`,
  copies the public pages (`index.html`, `demo/`, `receptionist/`,
  `operations/`, `admin/`, assets) into an artifact and publishes to GitHub
  Pages. `server/` is not part of the static deploy.
- **Backend tests** (`.github/workflows/test.yml`, introduced on the
  `chore/engineering-hygiene` branch for GitLab #71 — confirm it has merged
  to your baseline before relying on it): two jobs on every PR and push to
  `main`, both on Node 22 with `npm ci` in `server/`:
  - `backend-fast` — `npm test` (memory stores; the loud PG-pointer skip is
    expected there by design);
  - `backend-postgres` — `npm run test:pg`, the identical embedded-PostgreSQL
    path developers run locally: no connection string or credential appears
    anywhere in the workflow file, and it exercises the project's real
    migrations. A PostgreSQL failure fails CI. External actions are pinned to
    immutable commit SHAs; workflow permissions are read-only contents.

The browser and e2e suites are currently run locally (they need a Chromium
binary); they are not yet wired into a CI workflow.
