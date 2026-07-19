# ADR-0020: The GuideHerd Integration Contract

**Status:** Accepted — Implemented and merged (PR #34, main `c5c4b6e`); ships dark behind the per-capability `integration-providers` domain.
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 9), ADR-0003 (vendor
dependencies behind GuideHerd services), ADR-0007 (Extension Framework),
ADR-0011 (Notification Contract — the architectural sibling), ADR-0016
(Customer Configuration Framework), ADR-0017 (Durable Event Outbox),
ADR-0018 (Scheduler Contract)

## Context

The Notification Contract (ADR-0011) gave the platform one permanent
architecture for **customer-facing** communication. Nothing equivalent
existed for **system-to-system** communication, and the first real
integrations — practice management (Filevine, Clio), calendars beyond
notifications, CRMs, billing — are approaching. Without a contract, each
would arrive as its own bespoke seam: its own idempotency story, its own
retry rules, its own configuration, its own telemetry.

## Decision

### 1. One boundary for outbound system-to-system effects

Business code states an integration INTENT in GuideHerd domain language
("sync this consultation record"); the Integration Contract
(`server/integrations/`) owns everything after that: validation,
idempotency, provider selection, delivery, and telemetry. No provider
dialect is ever visible to a business workflow — the same ownership rule
the Notification Contract proved.

The boundary between the three communication contracts is precise:

| Contract | Owns |
|---|---|
| Notifications (ADR-0011) | customer-facing communication |
| Connect (ADR-0005) | live conversation providers |
| **Integrations (this ADR)** | record-and-data exchange with business systems |

A new capability belongs to exactly one of them.

### 2. The Notification Contract's shapes, deliberately reused

This is the sibling of ADR-0011, not a second pattern. Reused disciplines,
adapted only where system-to-system semantics differ:

- **Strict-allowlist requests**: `{ type, organizationKey, integrationKey,
  facts }` — unknown keys rejected, so provider payloads and stray PII can
  never ride along. `facts` are per-type allowlisted bounded scalars —
  identifiers and workflow-safe values only, never customer payload
  snapshots; business truth is re-read at the provider boundary.
- **Idempotency-key grammar**: `<type>:<logical-event-id>`, enforced (the
  key must be namespaced by its own type).
- **The standard claim machine** (`integration_deliveries`): atomic claim
  before any provider call; **'completed' is final forever**; 'failed' is
  re-claimable; stale 'pending' claims recover after the standard window.
  In-memory reference + PostgreSQL implementation
  (migration `0005-integrations.sql`), verified by one shared contract
  suite on both — and implemented as one shared core (§2a).
- **Provider registry** (ADR-0007 §6): providers register by key; selection
  is per-organization configuration; configured-but-unregistered fails
  loudly (and is recorded re-claimable, so recovery succeeds once the
  deployment registers the provider); a provider returning nonsense fails
  closed.
- **Duplication-safe retry classification**: the mailer's discipline —
  bounded retries inside the provider boundary, only for failures the
  provider classified as provably-not-accepted; acceptance-ambiguous
  failures are never blind-retried. Claim finality suppresses any
  duplicate effect regardless.
- **Correlation-aware telemetry** through the existing closed catalog
  (`integration.delivered` / `integration.delivery_failed` /
  `integration.suppressed`), carrying identifiers only — never fact
  values.

### 2a. One claim core, two domain contracts

Analysis: the Notification and Integration delivery stores were mechanically
identical — same claim conditions (first / failed / stale-pending), same
finality rule, same atomic PostgreSQL conditional INSERT/UPDATE, same
identifier-only records — differing only in key field name and final-status
name ('sent' vs 'completed'). Two copies of a correctness-critical machine
is exactly how drift happens.

Decision: the mechanics are extracted ONCE into
`server/reliability/claims.js` (in-memory core + PostgreSQL core + a
field-naming wrapper); both delivery stores are now thin domain wrappers
over it. The pre-existing notification tests pass unchanged against the
shared core — the strongest available proof that extraction preserved
semantics — and the integration contract suite runs the same core on both
store implementations.

What deliberately did NOT merge, to keep domain meaning intact: the public
store contracts (domain-named key fields), request validation, provider
contracts, telemetry, and retry POLICY — bounded attempts belong to the
callers (outbox consumers, scheduler handlers, workflow steps) and
duplication-safe retry classification to provider boundaries; the claim
stores stay attempt-free by design. Table/column identifiers in the
PostgreSQL core are wrapper-supplied compile-time constants, never runtime
input.

### 3. Provider selection is PER CAPABILITY, dark by default

One global provider per organization would be wrong permanently: a firm
will run several integrations at once (practice-management records,
calendars, billing, documents, analytics). The `integration-providers`
configuration domain (ADR-0016) therefore maps each integration TYPE —
the capability — to the provider that serves it:

    { "providers": { "demo-record-sync": "demo-integration",
                     "demo-calendar-sync": "capture-2" } }

Properties, all proven by test:

- multiple selections coexist per organization (different capabilities →
  different providers, simultaneously);
- one provider may serve several capabilities (map values repeat freely);
- a request declares its type; resolution reads exactly that type's
  mapping;
- an unmapped type is the controlled `not-configured` result — recorded,
  telemetered at `warn`, never an error — while sibling mappings keep
  working (there is no global switch to trip);
- writes are strict when the producer supplies context: every mapped type
  must be a registered capability AND every mapped provider must be
  registered on the deployment (ADR-0007 §6);
- the default map is empty — every capability ships dark.

Configuration is live — the next request honors a change. Business code
still states only its intent; no provider-specific branching exists
anywhere outside providers.

### 3a. Administration-time validation context

The fail-loudly guarantee is enforced at BOTH ends: runtime resolution
throws on an unregistered provider (defense in depth), and administration
writes are rejected up front. The Administration service now accepts a
composition-supplied `validationContext()` — a structured object carrying
every registry's keys (identity, conversation, notification, integration
providers; integration types; workflow types when ADR-0021 lands) —
passed through the Configuration Framework's existing context parameter.
No domain-specific validation lives in the Administration service; each
provider-selection domain picks the context keys it validates against.
This also activated the previously-dormant checks for the conversation
and notification provider domains.

### 4. Triggers are the existing pipeline; no second architecture

Integration intents are stated by callers running inside the platform's
canonical asynchronous machinery — durable outbox consumers (ADR-0017) and
scheduled-action handlers (ADR-0018), whose bounded retries and
at-least-once delivery this contract's claim machine makes duplication-
safe. The future Workflow Contract states integration intents through this
same entry point. No new poller, no external queue, no orchestration
product.

### 5. Operations visibility stays generic

Integration deliveries surface through the existing mechanisms: the
telemetry feed (correlation IDs, key grammar), the delivery store's
key-and-status records, and one `integration-provider` capability in the
health view. Zero integration-specific Operations Center architecture.

### 6. The demonstration provider and types

`demo-integration` proves the extension seam end to end — registration,
per-capability configuration-selected resolution, delivery, retry
classification, telemetry — with no network calls and no credentials, and
ships dark (registered everywhere, mapped nowhere). TWO synthetic types
(`demo-record-sync`, `demo-calendar-sync`) exist so the per-capability
model is exercised for real. A real provider (e.g. Clio) is one provider
implementation + one registration + one capability mapping, with zero
contract changes.

### 7. Designed-for, not built: inbound events

Webhook ingestion (external events arriving AT GuideHerd) is the
contract's natural next step: inbound events will resolve to the same
per-organization provider selection and state intents through the same
validated entry points. It is deliberately not built here; it arrives as
an extension, not a redesign.

## Out of scope (recorded)

Real provider implementations (Filevine, Clio, Graph, Google, CRM,
billing), OAuth and credential onboarding, inbound webhooks, and multi-step
orchestration (the Workflow Contract is its own decision).

## Consequences

- Every future system-to-system interaction has one required path, with
  idempotency, retries, configuration, and telemetry already solved.
- Provider work is additive registration, never contract change.
- The platform gains its fifth delivery-claim machine use with identical
  semantics — the pattern is now unambiguous platform vocabulary.
