# GuideHerd API Documentation

API contracts for GuideHerd services live here.

There are no published API specs yet — this directory is the home for them as
services are defined (starting with the Session Service and the Context Handoff
API on the pilot roadmap).

Every API documented here follows two rules from
[ARCHITECTURE.md](../../ARCHITECTURE.md):

- **GuideHerd domain language only.** Endpoints and payloads use business terms
  (Appointment, Consultation Type, Firm, Scheduling Session) — never vendor
  object names.
- **No vendor concepts in the contract.** Providers stay behind services; their
  shapes never appear in a public API.
