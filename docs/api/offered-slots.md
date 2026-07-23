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
  "consultationTypeId": "initial-consultation",
  "durationMinutes": 30,
  "sessionId": "optional, correlation + bypass diagnostics"
}
```

- `dateFrom` / `dateTo` — required `YYYY-MM-DD`, **inclusive calendar
  days in the organization's configured timezone**; window capped at 31
  days. **No slot array exists in this contract.**
- `attorneyId`, `consultationTypeId`, `durationMinutes`, `sessionId` —
  optional; sent only when established in the conversation, never
  fabricated. Duration defaults from configuration.

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
`{ "eventTypeId": <real Cal.com event type id>, "attorneyEventTypes": { "<attorneyKey>": <id> }, "durationMinutes": 30 }`.
A mapped attorney queries that attorney's event type and attributes the
slots; otherwise the org-wide event type is queried and slots stay
unattributed. **Provisioning fails closed** (`availability_not_configured`)
until a real event type is configured — no placeholder ships in any seed.
The Cal.com API key is environment configuration (`CALCOM_API_KEY`),
never a store value.

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
{ "status": "offered",         "slots": [ { "startsAt": "…", "durationMinutes": 30, "attorneyId": "…" } ], "window": { "dateFrom": "…", "dateTo": "…" } }
{ "status": "no-availability", "slots": [], "window": { … } }
```

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

## Booking consistency (mandatory demo gate)

Availability is resolved from `scheduling/calcom-availability`; booking
is created by the conversation layer's booking tool against ITS
configured Cal.com event type. **These must be the same event type** —
availability from one calendar must never be booked into another. With
per-attorney mappings, the booking tool must vary identically; for the
pilot, one shared event type on both sides is the verified
configuration. This parity is deployment verification (see the cutover
runbook), not yet server-enforced.

## Telemetry

Every check emits `scheduling.slots_offered` with `configMs`,
`providerMs` (split `providerHeadersMs`/`providerBodyMs` — finer network
phases are not observable through fetch), `rankMs`, `totalMs`,
`receivedCount`, `inWindowCount`, `offeredCount`, and status —
content-free. A `booked` outcome for a prepared session with no
offered-slots call emits `scheduling.policy_bypass_suspected` (warn) —
**diagnostic, not enforcement**: the bookkeeping is process memory on a
single-replica deployment, so a restart can produce a false warning.
Durable enforcement is a future Operations Store enhancement.

## Relationship to `POST /scheduling/slot-selection`

The batch endpoint remains for callers that already hold neutral slots
(demo-organization scoped, unchanged); the voice assistant no longer
uses it.
