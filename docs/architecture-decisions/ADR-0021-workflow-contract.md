# ADR-0021: The GuideHerd Workflow Contract

**Status:** Accepted — Implemented and merged (PR #35, main `13c37f3`); ships dark behind the `workflows` enablement domain.
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
deterministic by contract, and **null is the idempotent no-op** for a
signal the definition does not transition on. Duplicate safety is
structural, four layers deep:

1. instance creation is idempotent by `(workflowType, instanceKey)`;
2. **every accepted signal has a durable identity** (§3a), recorded
   atomically with its transition — re-delivery is refused outright;
3. a transition is an **atomic operation WITH its signal acceptance and
   its steps** — one store operation (one PostgreSQL transaction) that
   accepts the signal, advances the state, and durably records the
   intents, or does none of them; step keys are deterministic per
   transition, so even a racing duplicate appends nothing;
4. downstream, the Notification/Integration claim machines and the
   scheduler's actionKey dedupe absorb any replayed intent.

### 3a. Durable signal identity

State-version conflict alone is not sufficient dedup: in a definition
whose states can recur (A→B→A), a replayed old signal would find state A
again and wrongly re-fire. Every signal therefore carries a **durable,
stable identity** — `event:<outbox-event-id>` for durable events (the
outbox id is stable across redeliveries) and
`timeout:<instanceId>:<name>` for scheduled timeouts (one-shot by the
scheduler's own actionKey dedupe) — recorded per instance in the same
transaction as the transition it caused (`workflow_signals`, primary-key
arbitrated in PostgreSQL; a synchronous per-instance set in memory).

**The identity represents DELIVERY CONSUMPTION, not merely successful
state change.** A structurally valid signal presented to an existing
instance is consumed exactly once when its evaluation commits — whether
it transitioned, self-transitioned, or was deliberately ignored because
no transition applied. An ignored signal commits as a state-preserving
CAS with zero steps and a recorded outcome (`ignored` vs
`transitioned`), so stale history can never become a new business action
after the instance later enters a state where the old delivery WOULD
have transitioned. If a concurrent transition changes the state
mid-evaluation, the consumption CAS loses, nothing is consumed, and
redelivery re-evaluates against the new state — the correct
at-least-once semantics.

Explicitly NOT consumed, by rule: malformed signals rejected before
evaluation (call-site TypeErrors); signals to unknown instances (no
phantom instances are created to consume them — the delivery source's
bounded retry owns them); signals to TERMINAL instances (the state can
never change again, so replay is inert by construction); and any
evaluation that fails or rolls back before commit, which retries safely.

Consequences, all proven by test on both stores: replay of a consumed
identity is a recorded no-op forever — including the
ignored-in-A/actionable-in-B replay and after state recurrence;
concurrent delivery (transitioning or ignored) from multiple API
instances commits exactly once; a pre-commit failure rolls back signal,
state, and steps together, so the delivery retries safely; and the start
path's initial intents ride the starting event's identity, closing the
crash window between instance creation and intent recording. Signal
records hold identity strings and the outcome enum only — never payloads
or free text.

### 4. The platform's reliability model, reused

Steps follow the standard claim discipline: atomic claims (FOR UPDATE
SKIP LOCKED in PostgreSQL), attempt counting, stale-claim recovery after
the standard window, bounded attempts, then `abandoned` — loudly, via
telemetry. `drain()` sits behind the **existing** liveness poller next to
`outbox.drain()` and `scheduler.drain()`. No second processing
architecture, no external queue, no BPM engine.

Stores: in-memory reference + PostgreSQL (migration `0006-workflow.sql`),
verified by one shared contract suite on both.

### 5. Definitions are code; extension is one registration; versions are binding

A workflow definition declares `workflowType`, `version`, `startsOn`
(event type, optional guard, logical-key derivation), optional mid-flight
`reactsTo` subscriptions, `start()`, `transition()`, and
`terminalStates`. **A future workflow type is one definition + one
registration — zero engine changes** (ADR-0007). There is no DSL and no
visual designer; definitions are reviewed code.

**The definition version contract.** Versions are strictly-validated
positive integers, and registration identity is `(workflowType,
version)`. Every instance **persists the version it began under**
(`definition_version`) and every signal resolves that EXACT version —
never latest, so deploying a newer definition cannot silently change the
behavior of in-flight instances.

**Registration and activation are separate, explicit operations.** The
version that starts NEW instances is selected only by
`activate(workflowType, version)` in composition — the smallest coherent
mechanism, sitting beside registration itself. Registering V2 redirects
nothing; there is **no highest-wins, semver, lexical, or numeric
inference of any kind**. Activating an unregistered version fails loudly
(composition refuses to assemble), and a type registered without any
activation is resolution-only — a legitimate migration posture for
winding down old versions whose in-flight instances must still finish.
Multiple versions register concurrently during a migration window. A
version removed by a deploy while instances still reference it **fails
loudly** at signal time (`workflow_definition_unavailable`, naming
`type@version`), leaving the instance untouched and the failure
retried-bounded and telemetered by the signal source. Organization-level
enablement (the `workflows` domain) remains a separate, dark-by-default
layer. There is no migration DSL; moving an old instance forward is a
deliberate future operation, not an accident of deployment.

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
