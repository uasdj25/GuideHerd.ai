# Offered Slots API

The consolidated availability→offer seam. The conversation layer sends
ONE small request; GuideHerd fetches Cal.com availability server-side,
applies the existing sanitize → business-hours → ranking pipeline
(ADR-0012), and returns only what the assistant needs to speak. The
language model never transports slot batches — the model-mediated
two-tool transport whose token-generation latency and silent policy
bypass failed the Issue #66 voice test cannot recur by construction.

## Request

`POST /api/v1/scheduling/offered-slots` — service identity (Bearer)
holding `scheduling:select`, authorized against the **identity's own
organization** (no demo fallback; an identity without an organization
receives `403 organization_unresolved`). Cross-tenant access is
impossible by construction: the authorization target is the identity's
organization, and only that organization's configuration is resolved.

```json
{
  "dateFrom": "2026-09-01",
  "dateTo": "2026-09-07",
  "attorneyId": "clay-martinson",
  "practiceAreaId": "probate",
  "consultationTypeId": "initial-consultation",
  "durationMinutes": 30,
  "sessionId": "optional, correlation + bypass diagnostics"
}
```

- `dateFrom` / `dateTo` — required `YYYY-MM-DD`, **inclusive calendar
  days in the organization's configured timezone**; window capped at 31
  days. **No slot array exists in this contract.**
- `attorneyId`, `practiceAreaId`, `consultationTypeId`,
  `durationMinutes`, `sessionId` — optional; sent only when established
  in the conversation, never fabricated. Duration defaults from
  configuration. Attorney, practice-area, and consultation-type keys are
  **catalog-validated**: an unknown or inactive key is a `400`, never a
  routing input — the model can only transmit keys that exist.

### Window semantics (the GuideHerd contract)

`"2026-09-01".."2026-09-01"` means the tenant-local day September 1st,
midnight to midnight: an 18:30 local slot (already September 2nd in UTC)
is in-window; a slot on August 31st tenant-local is not, whatever its
UTC date. Local-midnight boundaries are computed per day through Intl —
on DST transition days the local day is genuinely 23 or 25 hours long —
and are applied BOTH to the Cal.com query bounds and as a hard
post-filter on whatever the provider returns. The final requested day is
never omitted or extended.

## Configuration (SQLite Configuration Store)

`scheduling/calcom-availability`:

```json
{
  "eventTypeId": 6287134,
  "attorneyEventTypes": { "<attorneyKey>": 6287134 },
  "routingGroupEventTypes": { "<routingGroupKey>": 6330099 },
  "durationMinutes": 30
}
```

`eventTypeId` is the **explicitly configured default path**: its presence
is the tenant's permission for no-context availability checks; removing
it disables that path. All ids must be positive **safe** integers.
Producer-gated writes and the seed-import gate run strict cross-entity
validation: every `attorneyEventTypes` key must reference an active
provider, every `routingGroupEventTypes` key an active routing group
whose service area has exactly one active group (unambiguous). The
Cal.com API key is environment configuration (`CALCOM_API_KEY`), never a
store value.

## Routing resolution — ONE decision shared with booking

Every check resolves exactly one route, persisted in a durable **booking
context** the booking endpoint later books inside (see
[booking.md](booking.md)). Precedence — **every miss FAILS CLOSED**
(`503 routing_unresolved`; no provider call, no times):

1. **Attorney + practice area** — honored only when the attorney belongs
   to the single active routing group for that practice area (membership
   is the Martinson & Beason tenant's configured eligibility policy for
   this demo, not a platform assumption) AND has an `attorneyEventTypes`
   mapping. A member without a mapping fails closed — a caller who asked
   for a specific attorney is never silently round-robined.
2. **Attorney only** — that attorney's mapping; unmapped fails closed
   (never silently rebooked onto the default calendar).
3. **Practice area only** — the single active routing group's
   `routingGroupEventTypes` mapping; the group's calendar (e.g. a
   Cal.com round-robin event) assigns the host, so slots stay
   unattributed — attribution is never fabricated.
4. **Neither** — the org-wide `eventTypeId`, only because its presence
   is the explicit permission (`availability_not_configured` otherwise).

## Provider fetch (interactive-voice discipline)

ONE bounded Cal.com request per check (`GET /v2/slots`,
`cal-api-version: 2024-09-04`), hard AbortController timeout — default
1200 ms, configurable via `GUIDEHERD_AVAILABILITY_TIMEOUT_MS`, clamped
to a strict 1500 ms production maximum — and **no retries**. Parsing
fails closed on unknown shapes, missing/malformed timestamps, provider
error envelopes served with HTTP 200, non-JSON bodies, and oversized
responses (> 3000 slots rejected, never truncated); duplicate timestamps
deduplicate deterministically (first occurrence wins). Accepted shapes:
v2 `{ "status": "success", "data": { "YYYY-MM-DD": [ { "start": ISO } ] } }`
and legacy `{ "slots": { "YYYY-MM-DD": [ { "time": ISO } ] } }`.

## Response — what the assistant can distinguish

```json
{ "status": "offered",         "slots": [ { "startsAt": "…", "durationMinutes": 30, "attorneyId": "…" } ], "window": { "dateFrom": "…", "dateTo": "…" }, "bookingContext": "bct_…" }
{ "status": "no-availability", "slots": [], "window": { … } }
```

`bookingContext` (offered only) is a cryptographically random opaque
value the assistant must retain verbatim for `create_booking` — it is
single-use, expires after 10 minutes, and its SHA-256 hash keys the
durable routing decision in PostgreSQL. The raw value appears nowhere
else: not in storage, logs, or telemetry.

- `offered` — ranked by the ADR-0012 engine over the COMPLETE in-window
  set (no pre-ranking truncation — a late slot the tenant's policy
  prefers can never be discarded), then trimmed to **at most 2 slots**:
  the assistant receives exactly what it presents. `attorneyId` is
  omitted (not null) when unattributed; internal `score` /
  `matchedDimensions` never leave the server.
- `no-availability` — the provider had nothing in-window, or the firm's
  own rules excluded everything (loudly telemetered).

## Failure policy — everything else fails closed

There is **no raw-slot fallback state**. Escalation (an error envelope;
the assistant must NOT offer times) for: provider timeout
(`504 availability_timeout`), network failure / provider HTTP failure /
error envelope behind 200 (`502 availability_provider_error`), malformed
or oversized responses (`502 availability_malformed`), missing provider
or tenant configuration (`503 availability_not_configured`,
`503 config_unavailable`), invalid requests (`400 validation_error`),
authentication/authorization (`401`/`403`), and **any unknown error**
(`500 internal_error`) — unknown exceptions propagate; nothing is caught
broadly to keep offering slots. A safe fallback would require ALL of:
availability fetched AND validated in the same execution, a narrowly
TYPED transient ranking-only failure, and business-hours/duration/tenant
validation still enforced — no such typed condition exists today, so no
fallback is pretended.

## Booking consistency — STRUCTURAL

Availability and booking share one server-side routing decision: the
resolved event type and the exact offered timestamps persist in the
booking context, and `POST /api/v1/scheduling/book` books strictly
inside it (see [booking.md](booking.md)). The conversation layer
transports only the opaque `bookingContext` — it cannot supply, see, or
override an event type, so availability from one calendar can never be
booked into another. The former deployment-verification gate is now
enforced by construction.

## Telemetry

Every check emits `scheduling.slots_offered` with `configMs`,
`providerMs` (split `providerHeadersMs`/`providerBodyMs` — finer network
phases are not observable through fetch), `rankMs`, `totalMs`,
`receivedCount`, `inWindowCount`, `offeredCount`, `routeKind`,
`bookingContextId` (the internal `bc_…` id — never the opaque value),
and status — content-free. A `booked` outcome for a prepared session with no
offered-slots call emits `scheduling.policy_bypass_suspected` (warn) —
**diagnostic, not enforcement**: the bookkeeping is process memory on a
single-replica deployment, so a restart can produce a false warning.
Durable enforcement is a future Operations Store enhancement.

## Relationship to `POST /scheduling/slot-selection`

The batch endpoint remains for callers that already hold neutral slots
(demo-organization scoped, unchanged); the voice assistant no longer
uses it.

## Native scheduling (provider-neutral) branch

When a tenant's governed `scheduling/calendar-targets` configuration
selects a native calendar provider (GitLab #79/#80), the SAME endpoint
and response schema are served by the native engine: GuideHerd resolves
the scheduling target set, reads busy intervals through the calendar
provider contract (ADR-0024), generates candidate slots from the firm's
business hours and booking-window policy, attributes every offered slot
to a specific attorney (routing-group pools use deterministic balanced
attribution — the attributed attorney is the attorney the booking lands
on), ranks through the scheduling policy engine, and issues the booking
context recording the exact calendar target behind each offered start.
All failure behavior stays fail-closed (`routing_unresolved`,
`availability_not_configured`, `calendar_unavailable` -> 502/503); with
no native provider configured, the legacy path serves the tenant
unchanged.
