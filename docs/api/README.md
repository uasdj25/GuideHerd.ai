# GuideHerd API Documentation

API contracts for GuideHerd services live here.

## Contracts

- [Context Handoff API (v1)](context-handoff.md) — passes short-lived caller
  context from the Receptionist Portal to the Scheduling Assistant.
  Implementation: [`server/`](../../server/README.md).

Every API documented here follows two rules from
[ARCHITECTURE.md](../../ARCHITECTURE.md):

- **GuideHerd domain language only.** Endpoints and payloads use business terms
  (Appointment, Consultation Type, Firm, Scheduling Session) — never vendor
  object names.
- **No vendor concepts in the contract.** Providers stay behind services; their
  shapes never appear in a public API.
