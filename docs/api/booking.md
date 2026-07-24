# Governed Booking API

The booking half of the consolidated scheduling flow. The offered-slots
check persists ONE routing decision — the resolved Cal.com event type,
duration, and the exact offered timestamps — as a durable **booking
context** (PostgreSQL under the `postgres` operational provider). This
endpoint books strictly inside it: the conversation layer transports an
opaque value and can neither choose nor override an event type, route,
or timestamp. Availability↔booking parity is structural, not procedural.

## Request

`POST /api/v1/scheduling/book` — service identity (Bearer) holding
`scheduling:book`, authorized against the **identity's own
organization** (no demo fallback; an identity without an organization
receives `403 organization_unresolved`).

```json
{
  "bookingContext": "bct_…  (opaque, from the offered-slots response)",
  "startsAt": "2026-09-01T14:00:00.000Z",
  "attendee": { "name": "…", "email": "…", "phoneNumber": "+1256…" },
  "sessionId": "optional — prepared-session correlation"
}
```

- `bookingContext` — required; the exact opaque value from the most
  recent offered-slots response. Single-use; expires 10 minutes after
  issue. Unknown and **cross-tenant** values are indistinguishable
  (`rejected` / `booking_context_unknown`) — existence never leaks.
- `startsAt` — required; must be one of the timestamps that response
  offered (compared as instants). A mismatched timestamp rejects the
  request **without consuming the context**.
- `attendee` — required `name` + `email`, optional `phoneNumber`; passed
  through to Cal.com, **never persisted by GuideHerd**. The attendee
  timezone is the tenant's configured timezone — never model-supplied.
- There is deliberately NO event-type-, route-, duration-, or
  slot-shaped input: unknown fields are `400`s.
- `bookingContext` works with or without `sessionId` — walk-in callers
  are first-class.

## Response — a tool-facing status envelope (HTTP 200)

Booking OUTCOMES ride HTTP 200 with a deterministic `status`, because
official ElevenLabs documentation does not guarantee non-2xx response
bodies reach the agent, and mis-hearing a booking outcome is a
caller-facing failure. Request/auth errors (400/401/403/503) remain HTTP
errors — the prompt's "any error → escalate" branch covers them.

```json
{ "status": "booked", "startsAt": "…", "durationMinutes": 30, "attorneyId": "…?" }
{ "status": "rejected",              "reason": "booking_context_unknown | booking_context_used | timestamp_not_offered | provider_rejected | booking_not_configured | slot_no_longer_available | availability_recheck_failed" }
{ "status": "expired",               "reason": "booking_context_expired" }
{ "status": "verification_required", "reason": "provider_timeout | network_failure | provider_http_5xx | missing_booking_uid | unparseable_success_body | booked_result_persistence_failed" }
```

- **`booked`** is present ONLY after Cal.com confirmed the booking AND
  the outcome row committed durably — never on process memory alone.
- **`rejected` / `expired`** — definitively NOT booked; the assistant
  may run a fresh availability check (which issues a new context).
- **`verification_required`** — the outcome is genuinely unknown
  (timeout after transmission, connection loss, provider 5xx, or a
  confirmed booking whose persistence failed). The assistant neither
  confirms nor denies; the office verifies against Cal.com. Emitted as
  `scheduling.booking_verification_required` (error severity) — never
  quiet, never auto-resolved.
- No envelope ever exposes event types, route internals, token hashes,
  provider payloads, or attendee data.

## State machine (booking_contexts)

```
offered ──claim──► booking_in_progress ──► booked
   │                     │──────────────► rejected
   │                     └──────────────► verification_required
   └──(lazy expiry)──► expired
```

The claim is one atomic conditional update (`WHERE status = 'offered'
AND expires_at > now`): of two concurrent booking requests exactly one
claims; the loser is `rejected` / `booking_context_used` and **never
reaches Cal.com**. PostgreSQL is authoritative for expiry, single-use,
cross-tenant opacity, concurrency, and the durable outcome. Rows
stranded in `booking_in_progress` (crash/redeploy mid-booking) are
flipped to `verification_required` by reconciliation at boot and on
every liveness-poller tick; a reconciliation failure emits
`internal.unexpected_error` (component `scheduling`, operation
`booking-reconciliation`) and never invents an outcome.

## Provider call (Cal.com)

ONE `POST /v2/bookings` per attempt (`cal-api-version: 2024-08-13` — the
version the tenant's live working integration uses), AbortController
timeout default 2500 ms (`GUIDEHERD_BOOKING_TIMEOUT_MS`, clamped to
5000 ms), **zero automatic retries**: official Cal.com V2 documentation
provides no idempotency mechanism for booking creation (verified
2026-07-22), so a retry after an ambiguous failure risks a double
booking. Outcome classification: 4xx / HTTP-200 error envelope →
definitive rejection; timeout / network failure / 5xx / unparseable or
uid-less success → `verification_required`. The request carries
`metadata.guideherdBookingContextId` (the internal `bc_…` id, never the
opaque value, never PII) so an operator can tie a Cal.com booking back
to its context. Only a sanitized confirmation subset (uid / start /
status) is persisted — never the raw provider payload.

## Reconciliation procedure (verification_required)

`booking_contexts` deliberately holds NO attendee PII, and walk-in
callers have no prepared session — so reconciliation never depends on
attendee identity. The authoritative procedure:

1. Identify the `verification_required` booking-context record.
2. Work from ITS stored fields: Cal.com event type, selected appointment
   timestamp, duration, organization, request timestamps, route identity
   (attorney / routing group / default), and the internal
   `booking_context_id`.
3. Query Cal.com (`GET /v2/bookings`) over the narrowest practical
   event-type and date/time window around the selected timestamp.
4. Inspect candidate bookings' metadata for
   `guideherdBookingContextId` equal to the stored internal
   `booking_context_id` — this is the match criterion.
5. Use attendee email only when it is independently available from the
   prepared session or another authorized operational source — never
   expect it from the booking context, and never treat it as required.
6. Never infer success solely because SOME booking exists at the same
   time — only the metadata match confirms this attempt.
7. Never automatically retry the booking.
8. Resolve the operational state only after the provider outcome is
   confirmed.

## Storage & hygiene

The raw `bookingContext` value exists only in the offered-slots response
body; storage holds its SHA-256 hash (`UNIQUE`). No attendee PII is
persisted in `booking_contexts`. Telemetry
(`scheduling.booking_created` / `booking_rejected` /
`booking_verification_required`) carries identifiers, enums, and
millisecond timings only.

## Deployment requirement

Durable booking correctness requires
`GUIDEHERD_OPERATIONAL_PROVIDER=postgres` (verified in production). The
in-memory reference store exists for tests, development, and the
contract suite — never for production booking.

## Native scheduling (provider-neutral) branch

A tenant whose governed `scheduling/calendar-targets` configuration
selects a native calendar provider is served by the native pipeline
behind the SAME endpoint and envelope (GitLab #80). Differences are
internal only:

- the context row carries a provider key and calendar target instead of
  a provider event type; the claim binds the exact offered target for
  the selected start (routing-group pool attribution becomes THE
  calendar — booking never re-chooses a route);
- double-booking prevention is GuideHerd's own: an atomic slot guard
  (one live claim/booking per organization + calendar + instant; the
  loser is `rejected` with reason `slot_no_longer_available` and its
  context is NOT consumed) plus a just-before-create busy re-check
  (`slot_no_longer_available` when the calendar filled up;
  `availability_recheck_failed` when the re-check itself could not read
  the calendar — definitive rejections, because no provider write was
  attempted);
- ambiguity classification is unchanged: only a failure AFTER the
  create attempt can be `verification_required`, and reconciliation
  locates the event by the booking-context correlation identifier the
  provider durably stores on every created event (ADR-0024) — never by
  attendee identity;
- every context transition is recorded in the append-only
  `scheduling_audit` history (best-effort after the transition commits;
  an audit failure is telemetry, never a booking failure).

With no native provider configured (all production tenants today), the
legacy path serves every request exactly as documented above.
