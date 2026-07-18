# ADR-0014: The GuideHerd Operations Center

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 1, 4, 10), ADR-0006
(Operational Store), ADR-0005 (conversation events), Issue #8 (telemetry —
whose event contract this consumes), ADR-0010/0013 (authorization and user
sessions — which protect it), ADR-0011 (notification delivery records)

## Context

Understanding what GuideHerd was doing meant reading deployment logs —
provider-shaped, host-shaped visibility. The platform already generates
everything an operator needs (durable handoff state, conversation events,
notification delivery records, structured telemetry with correlation
IDs); what was missing was a GuideHerd-owned surface over it. This ADR
establishes the permanent operational observability framework. The
dashboard is merely its first consumer.

## Decision

### 1. GuideHerd owns operational visibility

The Operations Contract (`server/operations/operations.js`) is a
queryable, organization-scoped surface over EXISTING GuideHerd data —
nothing duplicated: the Operational Store remains the source of truth for
handoff state; notification delivery records come from their store;
activity comes from the platform's own events. Providers never supply
dashboard data, and provider request IDs appear only as secondary
references — never as primary search identifiers.

### 2. Correlation IDs are first-class operational identifiers

The timeline view answers "what happened to this request?" from one
GuideHerd correlation ID: handoff lifecycle (derived from the session
record), conversation lifecycle (Connect events), notification events,
and operational events, merged chronologically — with no provider
implementation details. Search accepts GuideHerd identifiers only:
correlation ID, handoff/session ID, attorney, all inside the operator's
organization.

### 3. The event feed is allowlisted and, in v1, ephemeral

Recent activity is a bounded in-memory ring observed from the telemetry
emitter and the conversation-events seam. Every entry passes the Issue #8
field allowlist before it can ever be displayed — the feed structurally
cannot hold caller PII, tokens, or provider payloads. The feed is
deliberately ephemeral: durable operational-event persistence is the
outbox work ADR-0006 deferred, and the feed migrates onto it without
changing the Operations Contract. State views (handoffs, notifications)
are durable already — only the activity feed resets with the process.

The contract/source boundary is binding: consumers (routes, UI) touch
only the Operations Contract; ingestion is the single source-agnostic
`observe()` intake wired at composition. The outbox upgrade replaces the
feed's internals and strengthens semantics (restart survival,
cross-instance completeness, deep history + additive pagination) with NO
contract, route, or UI change.

### 4. Health is GuideHerd capabilities, not infrastructure

Health reports what the PLATFORM can do: operational-store,
configuration-store, notification-provider, scheduling-provider
(honestly `not-integrated` until the first Scheduling extension —
ADR-0012 §5), user-authentication, service-identity. Each check fails
closed to `unavailable`.

Boundary, binding on future integrations: ONE row per GuideHerd
capability in domain language regardless of provider count; status
answers "can GuideHerd do this now?" from the closed vocabulary; all
provider-specific detail (vendor, request ids, error categories) remains
diagnostic — telemetry today, the future integration-health drill-down
module later — and never becomes the primary health model. New
integrations register a capability check at composition, additively.

### 5. Protected by GuideHerd sessions and authorization

Operations routes ALWAYS require an authenticated user session (never
anonymous, regardless of the console enforcement floor) plus the new
`operations:read` permission, held by the org-scoped `operator` role.
`operator` is a permanent GuideHerd BUILT-IN role. The long-term
authorization trajectory (per ADR-0010): permissions remain the stable
closed primitive; role ASSIGNMENT becomes configuration next; eventually
organization-defined roles compose bundles as configuration — only over
existing GuideHerd permissions, only within organization scope, with
security-sensitive permissions markable non-delegable (the tighten-only
philosophy of ADR-0013).
Every query is scoped to the operator's own organization from the
server-held session — organization identifiers are never accepted from
input, and a correlation ID reveals nothing across organizations. Session
views expose operational metadata only; caller name, email, and phone are
stripped structurally before any route sees the data.

### 6. The dashboard is one consumer; modules are additive

`operations/index.html` is a deliberately simple operator tool: counters,
tables, timeline drill-down, health — no charts, no analytics. Recorded
direction: the Operations Center will later inherit the guideherd.ai
design language (typography, navigation, spacing, polish) as a pure
presentation change over exactly this architecture and contract. Future
operational modules (notification queue, reminder scheduler, durable
outbox, background jobs, diagnostics, audit history, integration health)
plug in as additional Operations Contract query methods plus dashboard
sections, additively.

## Consequences

- Operators diagnose GuideHerd from GuideHerd: a support conversation
  starts from a correlation ID and ends at a complete timeline, without
  provider log access.
- The ops surface ships dark in practice: it requires provisioned
  operator users (ADR-0013 activation), so production behavior is
  unchanged until users exist.
- Out of scope, recorded: analytics, business intelligence, reporting,
  customer metrics, billing, alerting, and monitoring infrastructure.
