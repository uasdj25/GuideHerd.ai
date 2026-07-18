# ADR-0017: The GuideHerd Durable Event Outbox

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** ADR-0005 (conversation lifecycle — the events now made
durable), ADR-0006 (Operational Store — the substrate and the deferred
"operational events" this delivers), ADR-0011 §3/ADR-0014 §3 (which both
pre-committed to this exact upgrade), ADR-0007 (extension discipline)

## Context

Asynchronous work rode an in-process, at-most-once pub/sub: a crash
between an outcome committing and the notification trigger finishing
LOST the notification, and the Operations Center's activity feed was an
ephemeral ring that reset with the process. Both ADR-0011 and ADR-0014
documented the same future fix. This ADR is that fix: the permanent
Durable Event Outbox — not a notification queue, not a scheduler; the
foundation notifications consume first and reminder scheduling,
Operations history, integrations, analytics, audit, and synchronization
build on next.

## Decision

### 1. The Outbox Contract

Business workflows publish durable GuideHerd DOMAIN EVENTS
(`server/outbox/outbox.js`; PostgreSQL store in
`server/operational/outbox-store.js`, migration 0003). Consumers register
(`consumer name + optional eventTypes + handle`) and process events
asynchronously. Producers never know who consumes; consumers never know
who produced. Event payloads carry safe GuideHerd facts only —
identifiers, statuses, timestamps; never tokens, PII, or provider
payloads (publishers construct them from repository state, tested by
scans).

### 2. The transactional boundary — exact

The publishing call sites are the REPOSITORY TRANSITION METHODS:
`connectEligible`/`redeem` publish `conversation.connected` and
`applyOutcome` publishes `conversation.completed`, each INSIDE the same
unit as the business change — the PostgreSQL insert uses the transition's
own transaction client (redeem gained a wrapping transaction whose atomic
guard remains the conditional UPDATE); the in-memory append is part of
the transition's single synchronous pass. Therefore: a business operation
cannot succeed without its event; no event can exist for a failed or
rolled-back operation; idempotent duplicate outcomes publish nothing.
Proven by commit/rollback/duplicate tests on both stores.

### 3. Delivery model and guarantees — precise

Per (event, consumer) delivery ledger:
`pending → processing → completed | failed → … → abandoned`.
Claims are atomic conditional writes (the platform's standard claim
pattern) — at most one concurrent processor per delivery, across
restarts and PostgreSQL instances. Bounded retries (default 5) with
deterministic clock-based backoff; exhaustion → `abandoned` (terminal,
telemetry-evented). A crash mid-processing leaves a stale `processing`
claim that re-claims after the stale window.

- **At-least-once delivery** to every registered consumer.
- **Exactly-once business effects** are the consumer's contract:
  consumers MUST be idempotent. The notification consumer is, via its
  delivery-claim `notificationKey`.
- **Isolation:** one consumer's failure never blocks another's delivery
  of the same event.
- **Ordering:** publication order within a drain pass; consumers must not
  assume global ordering across retries.

Processing is `drain()`, triggered three ways: a post-commit nudge from
the publishing workflow (low latency), boot-time restart recovery
(`server.js`), and a lightweight in-process POLLER
(`createOutboxPoller`) that drains on a configurable interval
(`GUIDEHERD_OUTBOX_POLL_INTERVAL_MS`, default 30s). The poller starts
after successful boot, stops when the server closes, arms exactly one
timer and re-arms it only after the previous drain resolves (poll loops
cannot overlap in-process; drain itself coalesces with nudges), and is
safe across API instances through the same atomic delivery claims — it
adds no coordination. Timing is injectable, so tests are deterministic.

**The liveness guarantee, precisely:**

- delivery is **at-least-once** to every registered consumer;
- every claimable delivery — a pending event, a retry whose backoff has
  elapsed, or a stale processing claim — is **eventually processed while
  at least one healthy API instance is running**, with no new traffic
  and no restart required;
- **exactly-once business effects** remain the consumer's idempotency
  responsibility.

### 4. Notifications: the first consumer — behavior identical

The in-process trigger is replaced by an outbox consumer subscribed to
`conversation.completed`. Same gates (booked only, per-organization
enablement at processing time — enabling later never resends history),
same lookup path, same Notification Contract, same exactly-once customer
effect. What changed is the guarantee: the old crash-loses-notification
gap (ADR-0011's documented transport note) is closed — the event is
durable and delivery retries.

### 5. Operations Center: a better event source, same contract

The outbox is the durable backbone of the operations feed: conversation
lifecycle now reaches `events()`/`timeline()` from the outbox (restart
survival and cross-instance completeness for free), while the in-memory
ring remains for ephemeral telemetry diagnostics. Operations Contract and
UI unchanged — exactly the source-swap ADR-0014 §3 pre-committed to.

### 6. Extension model

A future event type = one event definition published inside its owner's
transaction. A future consumer = one registration. Zero core changes for
either, zero producer changes for new consumers — demonstrated in tests
with a synthetic reminder-scheduler consumer. Future reminder scheduling
consumes a booked event, computes send-at times, and persists its own
schedule — on this foundation, without modifying it.

## Consequences

- The platform's asynchronous backbone exists: durable, transactional,
  retried, observable (outbox.delivered / delivery_failed / abandoned
  telemetry), and multi-instance safe.
- ADR-0011's transport note and ADR-0014's ephemeral-feed caveat are
  both resolved as designed.
- Deliberately out of scope: distributed messaging, brokers, multiple
  worker processes, cron scheduling, external infrastructure. The
  in-process poller behind `drain()` with claim-based multi-instance
  safety is sufficient until scale says otherwise; a dedicated worker
  split would slot in behind the same contract.
