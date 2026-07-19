# GuideHerd Developer Documentation

Documentation for engineers working on the GuideHerd platform (`server/` and
its test suites). The audience is a competent engineer who is new to this
codebase; the goal is that you can contribute — including building a new
provider end-to-end — from these pages plus the ADRs, without archaeology.

This is **internal** documentation. It deliberately does what the customer
documentation must never do (see `docs/customer/documentation-standards.md`):
it names source files, environment variables, contracts, and ADRs.

## Contents

| Page | What it covers |
|---|---|
| [architecture-overview.md](architecture-overview.md) | A prose map of the platform: the request path, the contracts and their boundaries, the asynchronous pipeline (outbox / scheduler / workflow engine behind one liveness poller), the two store families, and how composition in `server/handoff/app.js` assembles everything. Complements the repo-root `ARCHITECTURE.md`, which owns the logical/product model. |
| [local-development.md](local-development.md) | Running the server, seeding the Configuration Store, and running every test suite — backend (`npm test`), the real-PostgreSQL leg (`npm run test:pg` / `GUIDEHERD_TEST_DATABASE_URL`), the browser suites (`CHROMIUM_PATH`), and the single-process e2e — plus what CI runs. |
| [extension-points.md](extension-points.md) | **The core page.** Every extension seam with its exact contract shape, a minimal worked example, where it registers in `server/handoff/app.js`, how configuration selects it, and the fail-loudly / dark-by-default rules. Ends with a complete walkthrough: adding a Clio-style integration provider with zero Core changes. |
| [testing-standards.md](testing-standards.md) | The testing discipline: deterministic clocks, the shared contract-suite pattern, claim-machine expectations, fail-closed assertions, the telemetry field allowlist, adding a PostgreSQL-leg test, the loud-skip convention, and the frontend mock-fidelity rule. |

## Required prior reading

- `ARCHITECTURE.md` (repo root) — the platform model, engineering principles,
  and domain language. Short and required.
- `server/README.md` — the operational reference for the backend: run/test
  commands, environment variables, deployment modes, storage notes.
- `docs/architecture-decisions/` — ADR-0001 through ADR-0021. When a page here
  cites "ADR-0017", that file is the authority on *why*; these pages are the
  authority on *how to work with it today*.

## Where things live

- `server/` — the backend. One runtime dependency (`pg`, pinned; ADR-0006);
  everything else is Node built-ins. Node 22.5+.
- `server/handoff/app.js` — `createApp()`, the composition root. Every
  registry, provider, consumer, handler, and workflow is wired here.
- `server/server.js` — the deployment boot path: store selection, migrations,
  seed-on-boot, the liveness poller, fail-fast exits.
- `docs/architecture-decisions/` — ADRs.
- `docs/customer/` — customer documentation (different audience, different
  rules; do not copy internal terminology into it).
- `tests/frontend/`, `tests/e2e/` — browser suites (Playwright-core driving a
  real Chromium; no browser download at install time).

## Definition of done: documentation

The customer documentation standard (`docs/customer/documentation-standards.md`
§4, "Documentation is part of done") applies to these pages with the audience
swapped:

**Any change that alters developer-facing behavior updates these pages in the
same merge request.** Developer-facing behavior includes: a contract shape or
registration seam, a command or npm script, an environment variable's name or
semantics, a test convention, a store's guarantees, or the composition order
in `app.js` that an extension author must know about.

- Documentation lives **in this repository**, in Markdown, and changes through
  the same merge-request review as the code it describes. It is never
  maintained in a wiki or any external system that can drift.
- A feature is not complete when the code merges; it is complete when the next
  engineer can build on it from the documentation alone.
- If a change is purely internal with no developer-facing effect, say so
  explicitly in the merge request, so reviewers know documentation was
  considered rather than forgotten.
- Never document behavior that is not built, and never present a
  dark-by-default capability as if it were on. Every claim on these pages must
  be traceable to source; when you change the source, change the claim.
