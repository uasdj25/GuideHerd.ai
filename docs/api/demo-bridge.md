# Demo Bridge API — TEMPORARY DEMO INFRASTRUCTURE

> **Status: temporary.** These endpoints exist only to run the controlled
> Martinson & Beason demonstration. They are replaced by trusted telephony
> delivery of the handoff token, and must be disabled or removed at that point
> (see the setup guide's teardown step). The shared secret used here is **not
> production authentication**.

Both endpoints are server-to-server only:

- Authorized by `Authorization: Bearer <DEMO_BRIDGE_SECRET>` — the secret is
  configured only in the API environment and in the external Scheduling
  Assistant runtime's server-tool configuration. It is never accepted in a URL
  or request body, never logged, and compared in constant time.
- Missing/malformed authorization → `401`; wrong secret → `403`; secret not
  configured on the server → `503 demo_bridge_not_configured`.
- Responses carry `Cache-Control: no-store` and are **never granted browser
  CORS headers**, regardless of origin.

## POST /api/v1/demo/connect

Connects the controlled demonstration to the prepared session: the server-held
equivalent of handoff-token redemption. The raw handoff token never leaves the
API process.

The request **body is optional and ignored entirely** (`{}` and
`{"request": "connect"}` behave identically). It is tolerated only because the
external assistant runtime's webhook UI requires at least one JSON property on
POST tools.

Selection rules (deliberately safety-first):

- Only **unexpired `awaiting-transfer`** sessions for the demo firm are
  eligible. Cancelled, expired, connected, and terminal sessions are not.
- **Exactly one** eligible session → atomically redeemed (same single-use
  semantics as token redemption); returns `200`.
- **None** → `404 no_prepared_session`.
- **More than one** → `409 ambiguous_prepared_sessions` and **none** are
  redeemed. Cancel the extra sessions in GuideHerd Console and retry.
- Concurrent connect attempts produce exactly one successful redemption.

**Response — `200 OK`**

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "status": "connected",
  "caller": {
    "fullName": "Ryan Scoggins",
    "email": "ryan@example.com",
    "phone": "+12565551212"
  },
  "scheduling": {
    "attorneyId": "clay-martinson",
    "practiceAreaId": "personal-injury",
    "consultationTypeId": "initial-consultation"
  },
  "firmId": "martinson-beason"
}
```

Absent optional values are `null` (the existing redemption convention). The
response never contains tokens, hashes, receptionist user IDs, internal store
metadata, or provider-specific data.

## POST /api/v1/demo/outcome

Records the scheduling outcome using a **GuideHerd-owned contract** — never a
provider payload. The Scheduling Assistant reports the result **only after its
calendar tool has confirmed success or failure**.

**Request**

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "outcome": {
    "status": "booked",
    "appointment": {
      "startsAt": "2026-07-20T15:00:00-05:00",
      "timezone": "America/Chicago",
      "attorneyId": "clay-martinson",
      "consultationTypeId": "initial-consultation"
    },
    "schedulingSummary": "Initial consultation booked.",
    "unresolvedQuestions": [],
    "escalationRequired": false
  }
}
```

Rules:

- `outcome.status` ∈ `booked` | `failed` | `escalated`.
- `booked` **requires**:
  - `appointment.startsAt` — a **complete ISO-8601 datetime with an explicit
    UTC offset or `Z`** (e.g. `2026-07-20T15:00:00-05:00`). Date-only values
    and offset-less local datetimes are rejected.
  - `appointment.timezone` — a **valid IANA time-zone identifier** (e.g.
    `America/Chicago`), validated against the runtime's IANA database.
    Non-identifiers such as `Central Time` are rejected. (Note: the runtime's
    ICU data also accepts a few legacy abbreviations like `CST`.)
  A session is never reported booked merely because it connected.
- Only `connected` or `scheduling` sessions accept an outcome. Cancelled,
  expired, and awaiting-transfer sessions reject it without mutation.
- The **first valid terminal outcome wins**. An exactly identical duplicate is
  idempotent (`200`); a conflicting later outcome → `409 outcome_conflict`.
- Strict field allowlist: unknown keys (provider identifiers, transcripts,
  legal content) are rejected with `400`. Text fields are length-bounded.

**Response — `200 OK`**

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "status": "booked",
  "summaryDelivery": "sent"
}
```

`summaryDelivery` is the **separate** notification result: `sent` (Microsoft
Graph accepted the message), `failed` (retry permitted via an identical
outcome call), or `not-configured` (mail settings absent — a controlled
result, not an error). **Mail delivery failure never reverses a confirmed
booking.** A summary that was `sent` is never resent, including under
concurrent duplicate outcome calls.

## Deferred hardening

Direct calendar-provider webhook confirmation (rather than assistant-reported
outcomes) is the stronger production confirmation source and is deliberately
deferred from this slice.
