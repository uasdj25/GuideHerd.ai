# Architecture Overview

A working map of the backend for engineers. The repo-root `ARCHITECTURE.md`
owns the product-level model (layers, domain language, principles); this page
maps that model onto the actual code. Read both.

## One process, one composition root

The backend is a single Node process. `server/server.js` is the deployment
boot path; `server/handoff/app.js` exports `createApp()`, the composition
root that assembles every service, registry, and consumer and returns a raw
`node:http` handler plus handles to everything it built (`store`, `outbox`,
`scheduler`, `workflow`, `notifications`, `integrations`, `operations`,
`administration`, ...). Tests compose `createApp()` directly with injected
dependencies (fixed clock, in-memory stores, captured telemetry); production
composes it once in `server.js` with the stores selected by environment.

Service boundaries are **logical** (ARCHITECTURE.md): directories under
`server/` own contracts and import in one direction, not separate deployables.
`connect/` may import `handoff/` and read `config/`; neither imports back.

## The request path

1. `server.js` boots: opens the Configuration Store SQLite file, applies its
   migrations, optionally imports a seed document (`GUIDEHERD_SEED_FILE`),
   selects the Operational Store (`GUIDEHERD_OPERATIONAL_PROVIDER`: `memory`
   default, `postgres` durable — an unknown value or unreachable database
   exits non-zero; there is never a silent fallback), calls `createApp()`,
   drains the outbox/scheduler/workflow once (restart recovery), binds the
   port, then starts the liveness poller.
2. Every HTTP request enters `makeHandler()` in `server/handoff/app.js`. It:
   generates a fresh correlation ID (`server/telemetry/correlation.js`; a
   caller-supplied ID is adopted only after a trusted *service* identity
   authenticates), computes CORS headers from the explicit origin allowlist
   (never `*`; demo-bridge routes never get browser CORS), and routes by
   method + path.
3. Authentication is boundary-owned. Browser users present the `gh_session`
   HttpOnly cookie, validated by `identity/user-sessions.js` into a
   `GuideHerdIdentity`. Service callers present a bearer token read in exactly
   one place — `identity/middleware.js` — and authenticated by the configured
   Identity Provider (ADR-0009). Handoff/console tokens are capability
   credentials verified by the repository, deliberately outside the identity
   contract.
4. Authorization is a single decision point (`identity/authorization.js`,
   ADR-0010): routes state a GuideHerd permission
   (`authz.authorize(principal, 'handoff:create', { organizationKey })`);
   the policy decides; denials are audited; everything fails closed.
5. Business logic lives in services (`handoff/service.js`,
   `connect/conversations.js`, `administration/service.js`, ...), which talk
   to stores through async repository contracts and publish domain events to
   the outbox inside the same business transaction.
6. Errors: known error classes carry `status`/`code` and render a controlled
   envelope with the correlation ID; anything unexpected is sanitized
   (`sanitizeError` — name + stack frames, message stripped) and returned as a
   generic 500. Raw tokens, PII, and provider payloads never appear in logs.

## The contracts and their boundaries

Every external capability sits behind a GuideHerd-owned contract with a
provider registry (ADR-0007). The three delivery-shaped contracts divide the
world by *who is on the other end*:

- **Notifications** (`server/notifications/`, ADR-0011) — **customer-facing
  communication**. Core states a `NotificationRequest`; GuideHerd owns
  recipients, timing, content, and branding; a provider only delivers the
  rendered message. Exactly-once per `notificationKey`.
- **Connect** (`server/connect/`, ADR-0005) — **live conversations**.
  GuideHerd owns conversation state (prepared context, correlation,
  lifecycle, outcomes); a Conversation Adapter translates one provider's
  request dialect. Adapters never touch audio or SIP/RTP.
- **Integrations** (`server/integrations/`, ADR-0020) — **system-to-system
  records** (practice management, calendars, CRMs, billing). Core states an
  `IntegrationRequest` carrying *safe identifier facts only*; the provider
  re-reads business truth at delivery time. Per-capability provider
  selection; exactly-once per `integrationKey`; dark by default.

Alongside them: **Identity** (`server/identity/`, ADR-0009 — service
authentication providers), **User-Auth** (`identity/user-auth.js`, ADR-0013 —
browser login providers), **Scheduling policy** (`server/scheduling/`,
ADR-0012), **Administration** (`server/administration/`, ADR-0015 — the one
validated, audited producer over the Configuration Store), **Operations**
(`server/operations/`, ADR-0014 — read-only visibility over existing stores;
nothing duplicated), and **telemetry** (`server/telemetry/telemetry.js` — a
closed event catalog with a strict field allowlist).

## The asynchronous pipeline

Three cooperating pieces, one reliability model, one poller:

- **Durable Event Outbox** (`server/outbox/outbox.js`, ADR-0017).
  Repositories `append()` domain events *inside* the business transaction
  (memory: same synchronous pass; PostgreSQL: same transaction client), so an
  operation cannot succeed without its event. Registered consumers get
  per-(event, consumer) delivery records: atomic claims, bounded retries with
  deterministic backoff, stale-claim recovery, consumer isolation.
  At-least-once delivery; exactly-once *effects* are the consumer's
  idempotency responsibility.
- **Scheduler** (`server/scheduler/scheduler.js`, ADR-0018). Time-based
  business actions: `schedule({ actionKey, actionType, runAtMs,
  expiresAtMs?, payload })` with structural dedupe by `actionKey`; registered
  handlers execute due actions under the same claim/retry discipline; an
  action past `expiresAtMs` expires instead of running late.
- **Workflow engine** (`server/workflow/engine.js`, ADR-0021). Durable
  multi-step processes as code definitions, versioned with explicit
  `activate()`. It composes the other two through their public seams — one
  outbox consumer (`workflow-engine`) for start/mid-flight signals, one
  scheduler action type (`workflow.timeout`) for timeouts — and executes
  declarative intents (`notify`, `schedule-timeout`, `integrate`) via
  executors wired at composition. Signal consumption is durable: each
  signal's identity commits atomically with the transition, so redelivery is
  a recorded no-op.

**Liveness is one poller** (`createOutboxPoller`, started in `server.js`
after the port binds): a single unref'd timer whose tick awaits
`Promise.all([outbox.drain(), scheduler.drain(), workflow.drain()])`, re-armed
only after the previous drain resolves. Post-commit `drainSoon()` nudges give
low latency; boot-time drains give restart recovery; the poller guarantees
eventual processing with no traffic. No cron, no brokers, no second timer.

## The two store families

- **Configuration Store** (`server/config/`, ADR-0004): embedded SQLite
  (`node:sqlite`), per-customer configuration only — organizations,
  attorneys, practice areas, consultation types, routing, locations/hours,
  and namespaced JSON settings. A file, not a service; numbered SQL
  migrations (`config/migrations/NNNN-*.sql`) apply at boot. On top of the
  settings sits the **Customer Configuration Framework**
  (`server/configuration/framework.js`, ADR-0016): registered domains with
  lenient, fail-safe consumer reads and strict producer validation.
- **Operational Store** (`server/operational/`, ADR-0006): operational state —
  handoff sessions, notification/integration deliveries, outbox events,
  scheduled actions, workflow instances. Two implementations per repository
  contract: the in-memory reference (default; atomicity by single
  synchronous pass) and PostgreSQL (atomic conditional writes and advisory
  locks; multi-instance safe). Selection is `GUIDEHERD_OPERATIONAL_PROVIDER`
  in `server.js`; PostgreSQL migrations
  (`operational/migrations/0001..0006-*.sql`) are additive-only and apply
  transactionally under `pg_advisory_lock`. A shared contract suite runs
  against both implementations so they cannot drift (see
  testing-standards.md). The delivery-claim mechanics used by both the
  Notification and Integration stores are one implementation:
  `server/reliability/claims.js`.

Secrets never live in either store — credentials stay in the process
environment (variable *names* are listed in `server/README.md`).

## How ADRs relate to this code

ADRs are the decision record: each names the problem, the decision, and the
consequences, and the code cites them (`ADR-0017 §3`, etc.). When behavior and
an ADR disagree, that is a defect — fix one, in the same merge request. New
architectural seams get a new ADR; extensions *through* existing seams (a new
provider, consumer, handler, definition, or domain) explicitly do not
(ADR-0007) — that is the point of the seams. Start with ADR-0007 (extension
framework), ADR-0017 (outbox), and the ADR owning whichever contract you are
touching.
