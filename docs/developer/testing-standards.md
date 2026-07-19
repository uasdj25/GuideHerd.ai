# Testing Standards

The backend uses `node:test` + `node:assert/strict`, no test framework
dependencies. All data in tests is synthetic; no external provider is ever
called. These are the conventions the existing suites enforce — new tests
follow them.

## Determinism: fixed clocks, never sleeps

All time flows through the injected clock (`server/handoff/clock.js`):
`systemClock()` in production, `fixedClock(startMs)` in tests, with
`advance(ms)` and `set(ms)`. Expiration, stale-claim windows, backoff, and
scheduling are tested by *moving the clock*, never by sleeping, and never by
reading `Date.now()` in a test. The suites share a conventional epoch:

```js
const T0 = Date.parse('2026-07-12T15:15:00Z');
const clock = fixedClock(T0);
```

The outbox/scheduler/workflow processors are timer-free by design —
`drain()` is explicit and awaitable, and overlapping drains coalesce — so
asynchronous pipelines are tested deterministically by awaiting `drain()`.
The poller wraps timers behind an injectable `timers` seam
(`outbox/outbox.js:systemTimers()`) for the few tests that need it.

## The shared contract-suite pattern: one suite, both stores

Every repository contract with two implementations has **one** suite,
parameterized by a store factory, run against both — so the in-memory
reference and the PostgreSQL implementation can never drift apart silently
(the ADR-0006 discipline):

- `server/operational/contract-suite.js` — `runHandoffRepositoryContractSuite(label, makeStore)`
- `server/integrations/delivery-contract-suite.js` — `runIntegrationDeliveryStoreContractSuite(label, makeStore)`
- `server/workflow/store-contract-suite.js` — the workflow store suite

The memory leg always runs (e.g.
`runHandoffRepositoryContractSuite('memory', async ({ clock }) => createInMemoryHandoffStore({ clock }))`
in `operational/operational.test.js`); the PostgreSQL leg runs the *same
function* with a store built on the shared pool. If you add a repository
method, you add it to the contract suite — not to one implementation's tests.

## Claim-machine expectations

The delivery-claim machine (`server/reliability/claims.js`, wrapped by the
notification and integration delivery stores) has a fixed set of guarantees;
tests assert exactly these (see `delivery-contract-suite.js`):

- first claim wins; a concurrent duplicate is refused
  (`{ claimed: false, status: 'pending' }`);
- the domain's **final** status (`sent` / `completed`) is never re-claimed,
  even arbitrarily far past the stale window — the exactly-once effect;
- `failed` is re-claimable — recovery can retry;
- a stale `pending` claim recovers exactly at `STALE_CLAIM_MS`
  (boundary-tested: `STALE_CLAIM_MS - 1` refuses, `STALE_CLAIM_MS` grants);
- `not-configured` is a controlled recorded result;
- visibility records carry key + status + claim timestamp **only** — assert
  the exact key set (`Object.keys(r).sort()`), so payloads and customer data
  can never leak into operational views.

The same discipline shapes outbox/scheduler tests: at-least-once delivery,
bounded attempts ending in `abandoned`/terminal `failed`, and idempotent
handlers proven by replaying the same event/action and asserting one effect.

## Fail-closed assertions

Test the refusals, not just the happy path — the platform's rule is "loud or
dark, never half-working":

- unknown registry keys throw typed errors (e.g.
  `integration_provider_unavailable` / `permanent_internal_failure` in
  `integrations.test.js`) — never a substitute;
- a provider returning a status outside its vocabulary is recorded `failed`
  ("a provider returning nonsense fails closed" —
  `notifications/service.js`, `integrations/service.js`);
- unknown env values refuse to boot/compose (`GUIDEHERD_OPERATIONAL_PROVIDER`,
  `GUIDEHERD_CONSOLE_AUTH`); malformed provider config refuses to construct
  (`GUIDEHERD_STATIC_IDENTITIES`, `GUIDEHERD_DEV_USERS`);
- with `GUIDEHERD_CONSOLE_AUTH=required`, anonymous grants are withdrawn
  entirely — the e2e suite asserts the API answers 401 *with the real,
  well-formed payload*, because validation runs before authorization and a
  malformed body would 400 and prove nothing about failing closed
  (`tests/e2e/console-auth.e2e.js`).

## No PII in telemetry: the allowlist is the test

`server/telemetry/telemetry.js` has a closed `EVENTS` catalog and a strict
`ALLOWED_FIELDS` allowlist; unknown fields are dropped (never logged), and
`sanitizeError()` strips the message line from stacks. Tests capture the
emitter (inject `{ log }` or a `telemetry` fake) and assert both directions:
expected events appear with their identifiers, and **no** captured line
contains tokens, names, emails, phones, fact values, or provider payloads
(the demo integration provider even refuses to retain fact *values* in its
own test records — `demo-provider.js`). If your feature needs a new event
name or field, extend the catalog/allowlist deliberately, in the same MR,
with review — never bypass the emitter.

## Adding a PostgreSQL-leg test

Pattern from `operational/operational.test.js`:

1. Gate on the opt-in: `const PG_URL = process.env.GUIDEHERD_TEST_DATABASE_URL;`
2. Without it, **skip loudly** (see below) — never silently absent.
3. With it: `require` the PG modules *inside* the else-branch (so `npm test`
   never loads `pg` paths), build a pool with
   `createOperationalPool({ connectionString: PG_URL })`, run the real
   migration path (`operational/migrate.js`; the migration test asserts fresh
   apply, idempotent re-run, and advisory-lock serialization of concurrent
   runners), and reuse the shared contract suite with per-test `TRUNCATE`
   for clean state.
4. The suite drops/recreates its tables — it must only ever point at a
   disposable database. `npm run test:pg` supplies one automatically
   (embedded PostgreSQL, random unprinted credential); never print or log a
   connection string in test output.

PostgreSQL-only concerns (restart persistence, two instances sharing one
database, fail-fast boot) get their own `[postgres]`-labelled tests alongside
the contract suite.

## The loud-skip convention

An environment-dependent leg that cannot run must say so as a *visible
skipped test naming the switch*, not vanish:

```js
if (!PG_URL) {
  test('postgres suite skipped — set GUIDEHERD_TEST_DATABASE_URL to run it', (t) => {
    t.skip('no PostgreSQL test database configured');
  });
} else { /* the real leg */ }
```

The skip line in `npm test` output is expected and by design (CI's fast job
shows it; the `test:pg` job does not). Apply the same convention to any
future environment-gated leg.

## Frontend suites: the mock-fidelity rule

`tests/frontend/*.test.js` intercept `https://api.guideherd.ai/**` and stand
in for the real server — so **mocks must mirror the real server's CORS
behavior and response shapes**, not a convenient approximation. The
authoritative incident note, from `tests/frontend/console.test.js` (the
comment above its `CORS` helper):

> Mirrors the real server's CORS response (server/handoff/app.js
> corsHeadersFor). `Access-Control-Allow-Credentials` matters: the console
> sends its session cookie with `credentials: 'include'` (ADR-0013), and a
> credentialed cross-origin request is REJECTED by the browser unless the
> response carries this header. The mock previously omitted it, which made it
> unfaithful to the server it stands in for.

Practically: when you change `corsHeadersFor()`/response envelopes in
`app.js`, update the mock in the same MR; model the deployment floor the
mock represents explicitly (the console suite defaults to the `anonymous`
floor and tests opt into `required`); and remember the mocks cannot prove
end-to-end truth — that is what `tests/e2e/console-auth.e2e.js` (real
`createApp()`, real browser, no interception) exists for. Both browser
suites need a Chromium via `CHROMIUM_PATH` or `PLAYWRIGHT_BROWSERS_PATH`
(commands in local-development.md).
