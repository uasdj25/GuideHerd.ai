# ADR-0020: The GuideHerd Integration Contract

**Status:** Proposed
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
  suite on both.
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

### 3. Dark by default

The `integration-provider` configuration domain (ADR-0016) defaults to
`{ provider: null }`: an organization has NO integration provider until an
administrator names one. The service turns that default into the
controlled `not-configured` result — recorded, telemetered at `warn`,
never an error, never a crash. Writes are strict: a named provider must be
registered on the deployment when the producer supplies the registry
context. Configuration is live — the next request honors a change.

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

### 6. The demonstration provider

`demo-integration` proves the extension seam end to end — registration,
configuration-selected resolution, delivery, retry classification,
telemetry — with no network calls and no credentials, and ships dark (registered
everywhere, selected nowhere). A real provider (e.g. Clio) is one provider
implementation + one registration + configuration, with zero contract
changes.

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
