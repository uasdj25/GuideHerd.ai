# ADR-0003: Hide Vendor Dependencies Behind GuideHerd Services

**Status:** Accepted — implemented and governing on `main`.

## Status

Accepted

## Context

GuideHerd depends on external providers for voice, scheduling, calendar, email,
and AI. These providers change: pricing shifts, APIs deprecate, better options
appear, and models are replaced regularly. If customer-facing code calls these
providers directly, every such change becomes a change to the product — its
contracts, its behavior, sometimes its UI. The architecture should absorb vendor
change instead of transmitting it.

## Decision

Each vendor sits behind the GuideHerd service that owns its capability. Customer-
facing code depends on GuideHerd contracts, never on vendor-specific objects.

- **Scheduling providers** sit behind the **Scheduling Service**.
- **Voice providers** sit behind the voice capability GuideHerd exposes (through
  the Scheduling Assistant and Workflow Service).
- **Calendar providers** sit behind the Scheduling Service's scheduling/calendar
  abstraction.
- **AI providers and local models** sit behind the **Workflow Service (Lex)**.
- Customer-facing code must not import or depend on vendor-specific objects,
  event names, or IDs.
- Vendor **adapters** translate between a provider and the GuideHerd contract.
  An adapter can be swapped or rewritten without changing the contract.

## Consequences

- A vendor can be replaced by writing a new adapter; customer contracts and the
  experience stay the same.
- Vendor data exposure is contained to the service that owns it.
- **Tradeoff:** this adds a layer of abstraction and adapter code. We accept that
  cost deliberately — it buys product control and vendor flexibility, and it
  keeps provider churn out of the customer experience.

## Alternatives Considered

- **Call vendors directly from feature code.** Less code today, but couples the
  product to every provider and makes each vendor change a product change.
- **One universal integration layer for all vendors.** Collapses unrelated
  capabilities into a single abstraction; boundaries blur and the layer becomes a
  bottleneck. Per-capability services keep ownership clear.
