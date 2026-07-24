# ADR-0024: The Calendar Provider Contract (Native Scheduling)

**Status:** Accepted — first implementation ships with GitLab #75 (the
contract, the in-memory reference provider, and the conformance suite).
The Microsoft Graph provider (#83–#87) is the first real implementation;
Google Workspace is explicitly post-v1.0 and must land against this
contract without Scheduling Core changes.
**Date:** 2026-07-24
**Relates to:** ADR-0003 (hide vendors), ADR-0007 (Extension Framework),
ADR-0012 (scheduling policy engine), the governed booking-context
architecture (migration 0008, `server/scheduling/booking-context-store.js`),
GitLab #75/#94/#95, the GuideHerd Constitution (Principles 2, 3, 10)

## Context

GuideHerd v1.0 makes scheduling a native capability: GuideHerd computes
availability, governs booking, and owns the appointment lifecycle, with
external calendar services reduced to implementation details. The
deployed governed flow already proved the core guarantees (one durable
routing decision, opaque single-use booking contexts, fail-closed
routing, booked-only-after-confirmation-and-persistence,
verification_required for ambiguity) — but its availability and booking
clients speak one provider's dialect directly. Replacing that provider,
or adding another, must never mean re-teaching the Core how calendars
work.

## Decision

One contract — `server/scheduling/calendar-provider.js` — is the ONLY
boundary between Scheduling Core and any external calendar service.

**Operations:** `discoverCalendars`, `fetchBusyIntervals`, `createEvent`,
`updateEvent`, `cancelEvent`, `findEventByCorrelation`. Nothing else. A
provider translates these into its service's API and translates responses
back into the normalized shapes (calendar reference, busy interval,
sanitized event). A provider never routes, ranks, applies policy, owns
lifecycle state, or sees tenant business rules.

**Outcome trichotomy for state-changing operations:**

| Outcome   | Mechanism                        | Core mapping             |
|-----------|----------------------------------|--------------------------|
| Confirmed | return value with providerEventId | booked / applied         |
| Rejected  | `CalendarWriteRejectedError`     | definitive rejection     |
| Ambiguous | `CalendarWriteUnverifiedError`   | verification_required    |

Reads that fail (timeout, provider error, malformed, inaccessible
calendar) throw `CalendarUnavailableError` — FAIL CLOSED: partial
availability is never presented as complete and free time is never
guessed.

**Contract rules (enforced by the conformance suite):**

1. **Adapters never retry.** Not writes (no calendar service in scope
   documents a proven idempotency mechanism for event creation; a retry
   after ambiguity risks a double booking) and not reads (retry/backoff
   belongs to the caller, which owns the latency budget). One call, one
   transport attempt.
2. **Correlation is mandatory.** Every created event durably carries the
   caller's `correlationId` (the booking-context internal id — never the
   opaque context value, never PII). Reconciliation locates events by
   correlation, never by attendee identity or same-time inference.
3. **Mutation requires correlation.** `updateEvent`/`cancelEvent` verify
   the stored correlation before touching anything; a mismatch is a
   definitive `correlation_mismatch` rejection with no mutation.
4. **Sanitized results only.** `{ providerEventId, startsAt, status }` —
   never raw provider payloads, never attendee echo, never secrets.
5. **Bounded timeouts** are fixed at adapter construction from
   caller-clamped budgets; no socket defaults.

**Certification:** `calendar-provider-contract-suite.js` runs against a
harness (`givenCalendar` / `injectFailure` / `attempts` / `eventsOn`).
The in-memory reference provider passes it and is the contract's
executable specification; a real provider wraps its mocked transport in
the same harness and must pass the identical suite (Graph: #85/#86
conformance, live proof deferred to #95). The reference provider doubles
as the deterministic fake for Core tests — created events feed back into
busy intervals, so offer → book → re-check flows exercise realistic
calendar state with zero IO.

**Purity enforcement:** a test scans native-core files (comments
stripped) for concrete provider identifiers; the list grows with each
native module. Core code naming a provider fails the build.

## Consequences

- The Cal.com integration remains a TRANSITIONAL provider during
  coexistence (its event-type mapping isolated inside its own module,
  #76) and is removed by #97; the Core it plugs into never learns
  Cal.com vocabulary again.
- Ambiguity handling is uniform: every provider's "maybe" lands in the
  same verification_required lane with the same evidence-based
  reconciliation path (#87, #93).
- Live provider behavior (real throttling, extension round-trips,
  permission scopes) is deliberately OUT of the conformance suite —
  those are live-validation concerns tracked in #95 and must never be
  claimed from mocks.
