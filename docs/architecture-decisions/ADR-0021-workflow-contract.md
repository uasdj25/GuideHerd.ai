# ADR-0021: The GuideHerd Workflow Contract

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 9), ADR-0007
(Extension Framework), ADR-0011 (Notification Contract), ADR-0016
(Customer Configuration Framework), ADR-0017 (Durable Event Outbox),
ADR-0018 (Scheduler Contract), ADR-0020 (Integration Contract)

## Context

Every platform capability to date is single-step: an event triggers an
action which states an intent, and the story ends. The missing fundamental
is a durable engine for **multi-step business processes** — intake
sequences, document requests, follow-ups, escalations — that survive
restarts, advance over days, and never duplicate their effects.

## Decision

### 1. Saga / Process Manager, composed from what exists

The Workflow Contract (`server/workflow/`) is the permanent home for
multi-step GuideHerd business processes. It **composes** the platform and
replaces nothing:

- instances **start and advance on durable outbox events** (ADR-0017);
- time-based transitions are **one-shot scheduled actions** (ADR-0018),
  via a single engine-owned action type (`workflow.timeout`);
- customer-visible steps are **notification intents** (ADR-0011);
- system-to-system steps are **integration intents** (ADR-0020);
- per-organization enablement is a **configuration domain** (ADR-0016).

The Outbox, Scheduler, Notification, and Integration contracts remain
completely unaware of workflows: the engine registers one outbox consumer
and one scheduler handler through their public seams, exactly as the
appointment-reminders workflow did before it.

### 2. Instances are platform state, never customer snapshots

A workflow instance holds: instance id, workflow type, logical instance
key, organization, related entity id, current state, **safe state facts**
(validated bounded scalars — identifiers only), correlation id, and
timestamps. Business truth (a caller's email, an appointment's time) is
**re-read from the owning stores at step execution** — the executor
discipline, enforced structurally by state/intent validation that rejects
nested objects and unbounded strings.

### 3. Deterministic, idempotent transitions

`transition(currentState, signal) → null | { nextState, intents }` —
deterministic by contract, and **null is the idempotent no-op**: a
duplicate or unexpected signal (at-least-once outbox redelivery, a
scheduler retry, a stale-claim re-execution) changes nothing. Duplicate
safety is structural, three layers deep:

1. instance creation is idempotent by `(workflowType, instanceKey)`;
2. a transition is an **atomic compare-and-set WITH its steps** — one
   store operation (one PostgreSQL transaction) that either advances the
   state and durably records the transition's intents, or does neither;
   step keys are deterministic per transition, so even a racing duplicate
   appends nothing;
3. downstream, the Notification/Integration claim machines and the
   scheduler's actionKey dedupe absorb any replayed intent.

### 4. The platform's reliability model, reused

Steps follow the standard claim discipline: atomic claims (FOR UPDATE
SKIP LOCKED in PostgreSQL), attempt counting, stale-claim recovery after
the standard window, bounded attempts, then `abandoned` — loudly, via
telemetry. `drain()` sits behind the **existing** liveness poller next to
`outbox.drain()` and `scheduler.drain()`. No second processing
architecture, no external queue, no BPM engine.

Stores: in-memory reference + PostgreSQL (migration `0006-workflow.sql`),
verified by one shared contract suite on both.

### 5. Definitions are code; extension is one registration

A workflow definition declares `workflowType`, `version`, `startsOn`
(event type, optional guard, logical-key derivation), optional mid-flight
`reactsTo` subscriptions, `start()`, `transition()`, and
`terminalStates`. **A future workflow type is one definition + one
registration — zero engine changes** (ADR-0007). There is no DSL and no
visual designer; definitions are reviewed code.

Intents are declarative, identifier-only descriptors dispatched to
**intent executors** registered at composition. The engine knows no
services; app.js wires `schedule-timeout` and `notify` always, and
`integrate` only because that deployment composes the Integration
Contract — a definition that never states integration intents is fully
functional without it (proven by test).

### 6. Dark by default

The `workflows` configuration domain defaults to `{ enabledTypes: [] }`.
An instance starts only when the organization's configuration lists the
workflow type, checked at event time — enabling later never backfills
historical (settled) events. Writes are strict against the registered
definition types; reads fail safe to dark.

### 7. Operations visibility stays generic

Instance lifecycle surfaces through the existing telemetry feed
(`workflow.instance_started` / `.transitioned` / `.completed` /
`.step_failed` / `.step_abandoned`, correlation-aware, identifier-only)
plus one `workflow-engine` capability in the health view. Zero
workflow-specific Operations Center architecture; the store's
`listInstances` exposes identifiers and states for any future generic
view.

### 8. The demonstration workflow

`demo-follow-up` (ships dark) proves the composition end to end with real
machinery: a real `conversation.completed` (booked) event starts the
instance → a real one-shot scheduled timeout fires an hour later → a
deterministic transition to the terminal state states a real
`appointment-reminder` notification intent through the Notification
Contract. It is deliberately synthetic; production workflows (intake,
document requests) are future definitions on this foundation.

## Out of scope (recorded)

Production workflows, inbound webhooks (arrive with Integration Contract
extension work), visual designers/DSLs, distributed orchestration
infrastructure, external queues.

## Consequences

- Multi-step processes have one durable home with restart survival,
  duplicate safety, and bounded failure — none of it re-invented per
  workflow.
- The single-step contracts stay single-step and workflow-unaware;
  composition is one-directional by construction.
- Mid-flight disablement is deliberately NOT interruption: disabling a
  type stops new instances; in-flight instances run to their terminal
  states. Interrupting live processes would need its own decision.
