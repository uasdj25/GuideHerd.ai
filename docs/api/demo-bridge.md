# Demo Bridge API — TEMPORARY DEMO INFRASTRUCTURE

> **Status: temporary.** These endpoints exist only to run the controlled
> Martinson & Beason demonstration. They are replaced by trusted telephony
> delivery of the handoff token, and must be disabled or removed at that point
> (see the setup guide's teardown step). The shared secret used here is **not
> production authentication**.

All endpoints are server-to-server only:

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
    "phone": "+12565551212",
    "existingClient": false
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

**Two accepted request formats.** The canonical nested format is below; a
**flat format** is also accepted because the external assistant runtime's
webhook editor cannot practically construct nested objects. The flat body is
lifted into the nested shape internally and passes through **identical
validation** — nothing is looser about it. `reason` is an alias for
`schedulingSummary` (supplying both is rejected). Mixing formats in one body
(`outcome` plus flat fields) is rejected. The same outcome submitted in either
format counts as an idempotent duplicate.

**Flat request** (webhook-editor friendly)

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "status": "booked",
  "appointment": {
    "startsAt": "2026-07-20T15:00:00-05:00",
    "timezone": "America/Chicago",
    "attorneyId": "clay-martinson",
    "consultationTypeId": "initial-consultation"
  },
  "reason": "Initial consultation booked."
}
```

**Nested request** (canonical)

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

## GET /api/v1/demo/summary/latest

> **Temporary operator view.** This endpoint exists only so the demo operator
> can show the GuideHerd Consultation Summary before Microsoft Graph mail
> delivery is configured. It does not replace delivery: the summary remains a
> domain artifact, and the Graph mailer path is unchanged. Remove this endpoint
> together with the rest of the demo bridge (see the setup guide's teardown
> step).

Returns the **most recently completed** Consultation Summary for the demo firm
as a self-contained, GuideHerd-branded HTML document — the same rendering the
mailer would send.

- Authorization: `Authorization: Bearer <DEMO_BRIDGE_SECRET>` — identical auth
  matrix to the other bridge endpoints (`401` missing/malformed, `403` wrong
  secret, `503` unconfigured).
- Selection: sessions in a terminal outcome state (`booked`, `failed`,
  `escalated`) for the demo firm, newest by completion time. Prepared,
  connected, cancelled, and expired sessions are never eligible.
- **`404 no_completed_summary`** when no completed session exists.
- Response: `200` with `Content-Type: text/html; charset=utf-8` and
  `Cache-Control: no-store`. No browser CORS headers, ever.
- The HTML contains only what the summary email would: caller-facing
  scheduling details. It never contains tokens, hashes, session IDs, the
  bridge secret, provider/vendor names, transcripts, or legal content.
- This is an **operator tool for a terminal, not a web page**. Do not embed
  the secret in any browser page, bookmark, or URL — see the setup guide for
  the supported curl workflow.

## Deferred hardening

Direct calendar-provider webhook confirmation (rather than assistant-reported
outcomes) is the stronger production confirmation source and is deliberately
deferred from this slice.
