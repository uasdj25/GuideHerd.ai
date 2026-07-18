# Context Handoff API (v1)

Passes short-lived caller context from the GuideHerd Console to the GuideHerd
Scheduling Assistant. The receptionist qualifies a caller, GuideHerd creates a
**Scheduling Session** and a single-use **handoff token**, and the assistant
redeems that token to receive the minimum context it needs to book a
consultation.

This contract uses GuideHerd domain language only. No vendor concepts (voice,
scheduling, calendar, or model providers) appear anywhere in it.

> **Scope:** scheduling context only. This API does not accept or store legal
> intake, SSNs, payment details, documents, or case facts.

## Credentials

Each Scheduling Session issues **two separate bearer credentials**, returned
once on creation and stored server-side only as hashes:

| Credential | Held by | Can do | Cannot do |
|---|---|---|---|
| `handoffToken` | Scheduling assistant (voice side) | Redeem caller context, exactly once | Check status, cancel |
| `consoleToken` | GuideHerd Console | Check status, cancel | Redeem caller context |

Neither credential can be exchanged for the other. The handoff token dies at
redemption, cancellation, or expiry — whichever comes first. The console token
is never promoted beyond read/cancel and is useless after the session record
ends. In the current slice the browser receives both from the create
response and holds them **in JavaScript memory only**; the future telephony
integration will receive the `handoffToken` through a trusted GuideHerd
handoff mechanism instead of the browser.

## Security assumptions

- Both tokens are **bearer credentials**. The handoff token is single-use;
  both expire **10 minutes** after creation.
- Tokens are generated from a cryptographically secure source and are stored
  only as a hash. The raw token is returned once, on creation.
- The handoff token is accepted **only in the request body**; the console
  token is accepted **only in the `Authorization: Bearer` header**. Tokens
  never appear in URLs.
- Tokens are never logged and never appear in error messages.
- **Authorization (ADR-0010):** every route passes through the GuideHerd
  authorization boundary. Both tokens are session **capability credentials**:
  a handoff token authorizes only `handoff:redeem` on exactly its own
  session; a console token authorizes only `handoff:read` and
  `handoff:cancel` on exactly its own session. Neither grants any broader
  organization or platform access.
- **Route classification (ADR-0010):** session creation
  (`POST /api/v1/handoffs`) and scheduling options are **public by design**
  — declared as explicit anonymous grants in the authorization policy —
  until a user-facing identity provider and login flow arrive through the
  Identity Contract (ADR-0009). Anonymous creation is contained by a
  per-organization cap on concurrently prepared sessions
  (`GUIDEHERD_MAX_PREPARED_SESSIONS`, default 20 →
  `429 too_many_prepared_sessions`). User authentication for the Reception
  Console remains a required production milestone.

## Browser access (CORS)

Browser callers must come from an allowlisted origin, configured with the
`CORS_ALLOWED_ORIGINS` environment variable (comma-separated). The default
allowlist is:

- `https://guideherd.ai`
- `http://localhost:8080`

Rules:

- A wildcard (`*`) origin is **never** allowed; wildcard entries are ignored.
- Preflight `OPTIONS` requests are supported.
- Only `POST`, `GET`, `DELETE`, and `OPTIONS` methods are permitted.
- Only the `Content-Type` and `Authorization` request headers are permitted.
- Requests from non-allowlisted origins receive no CORS headers, so browsers
  block the response.

## Endpoints

### POST /api/v1/handoffs

Create a Scheduling Session and return a single-use handoff token.

**Request fields**

| Field | Required | Notes |
|-------|----------|-------|
| `firmId` | yes | Firm the session belongs to |
| `caller.fullName` | yes | Caller's full name |
| `caller.email` | yes | Caller email. Trimmed; local part preserved exactly; domain lowercased; max 254 chars |
| `caller.phone` | no | Caller phone (stored as provided; not parsed) |
| `scheduling.attorneyId` | no | Attorney the caller wants; omitted when the caller has no preference or the practice area has no attorneys configured |
| `scheduling.practiceAreaId` | no | Practice area |
| `scheduling.consultationTypeId` | yes | One of the firm's configured consultation types |
| `handoff.createdByUserId` | no | Receptionist who created the handoff |
| `handoff.source` | yes | Where the handoff originated |
| `handoff.mode` | yes | Handoff mode (e.g. live transfer) |

String fields are trimmed; blank required values are rejected. Each string field
has a maximum length to reject oversized payloads.

> **Contract change (Slice 3, intentional and coordinated):** `caller.email`
> is now **required**. Existing create clients that do not send it receive
> `400 validation_error`. All repository clients were updated in the same
> change; the API is not version-bumped during the pilot. The email is
> returned **only** through authorized context redemption (token redemption or
> the demo connect) — never in status or cancellation responses.

> **Contract change (config-driven console, intentional and coordinated):**
> `scheduling.existingClient` has been **removed**. The console's former
> prospective/existing-client toggle has been replaced by required consultation
> type selection from the firm's configuration (which includes an
> "Existing Client" type). Clients still sending `existingClient` have it
> silently ignored, consistent with the API's handling of unknown fields.

**Example request**

```json
{
  "firmId": "martinson-beason",
  "caller": { "fullName": "David Jones", "email": "david.jones@example.com", "phone": "+14044232676" },
  "scheduling": {
    "attorneyId": "clay-martinson",
    "practiceAreaId": "personal-injury",
    "consultationTypeId": "initial-consultation"
  },
  "handoff": {
    "createdByUserId": "receptionist-001",
    "source": "receptionist-portal",
    "mode": "live-transfer"
  }
}
```

**Example response — `201 Created`**

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "handoffToken": "gh_handoff_tpBXaTbPppdfoF8MxWzui6wheKfKfu6OufSPSBXcvns",
  "consoleToken": "gh_console_Qm93c2VyT25seUluTWVtb3J5RXhhbXBsZVZhbHVl",
  "status": "awaiting-transfer",
  "createdAt": "2026-07-12T15:15:00.000Z",
  "expiresAt": "2026-07-12T15:25:00.000Z",
  "expiresInSeconds": 600
}
```

Timestamps are ISO-8601 in UTC.

### POST /api/v1/handoffs/redeem

Redeem a handoff token exactly once and return the minimum context the
Scheduling Assistant needs. On success the session moves from
`awaiting-transfer` to `connected`.

**Request**

```json
{ "handoffToken": "gh_handoff_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

**Example response — `200 OK`**

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "callerName": "David Jones",
  "callerLastName": "Jones",
  "callerEmail": "david.jones@example.com",
  "callerPhone": "+14044232676",
  "attorneyId": "clay-martinson",
  "practiceAreaId": "personal-injury",
  "consultationTypeId": "initial-consultation",
  "status": "connected"
}
```

The response is deliberately minimal. It does **not** include the receptionist
user ID, handoff source/mode, token metadata, or any vendor-specific data.
Optional values that were not provided are returned as `null`.

### GET /api/v1/handoffs/{sessionId}

Operational status for the GuideHerd Console. Requires the console token:

```http
Authorization: Bearer gh_console_...
```

**Example response — `200 OK`** (`Cache-Control: no-store`)

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "status": "awaiting-transfer",
  "createdAt": "2026-07-12T15:15:00.000Z",
  "expiresAt": "2026-07-12T15:25:00.000Z"
}
```

Returns **operational metadata only** — never caller name, phone, email,
receptionist user ID, or any token. Once a session is `booked`, the response
additionally carries the confirmed appointment (scheduling metadata only):

```json
{ "status": "booked", "appointment": { "startsAt": "2026-07-20T15:00:00-05:00", "timezone": "America/Chicago", "attorneyId": "clay-martinson", "consultationTypeId": "initial-consultation" } }
```

| Session state | Result |
|---|---|
| Awaiting transfer | `200`, status `awaiting-transfer` |
| Redeemed by the assistant | `200`, status `connected` |
| Outcome recorded | `200`, status `booked` (with `appointment`), `failed`, or `escalated` |
| Cancelled | `200`, status `cancelled` |
| Past `expiresAt` | `200`, status `expired` (no caller context) |
| Missing/malformed `Authorization` | `401` |
| Wrong token (incl. the handoff token) | `403` |
| Unknown session | `404` |

### DELETE /api/v1/handoffs/{sessionId}

Cancel a pending session. Requires the console token in the same
`Authorization: Bearer` format.

**Example response — `200 OK`**

```json
{
  "sessionId": "23d7d46b-933b-4dee-8675-41737cea85c5",
  "status": "cancelled"
}
```

Semantics:

- Only `awaiting-transfer` sessions can be cancelled. Cancellation is atomic —
  a concurrent redeem and cancel settle into exactly one terminal state.
- Already connected → `409 cannot_cancel`.
- Expired (never cancelled) → `410 session_expired`.
- Missing auth → `401`; wrong token → `403`; unknown session → `404`.

**Credential semantics after cancellation (exact contract):**

- The **handoff token is immediately and permanently invalidated**: any later
  redeem attempt receives `410 token_cancelled`. This is enforced before any
  other check, so a cancelled session's caller context can never be read.
- The **console token is *not* invalidated** by cancellation. It remains a
  strictly read/cancel-only credential:
  - it can read the session's terminal status (`GET` → `200`, status
    `cancelled`);
  - until the session's original `expiresAt`, a repeat `DELETE` is
    **idempotent** (`200`, status `cancelled`); after `expiresAt`, a repeat
    `DELETE` receives `410 session_expired`;
  - it can never redeem caller context and can never cause any further
    status transition.

No caller context is ever exposed by cancellation responses.

## Status codes

| Code | When |
|------|------|
| `201 Created` | Session created |
| `200 OK` | Token redeemed |
| `400 Bad Request` | Malformed JSON or failed validation |
| `404 Not Found` | Unknown token (or unknown route) |
| `409 Conflict` | Token already redeemed |
| `410 Gone` | Token expired |

**Error body**

```json
{
  "error": {
    "code": "validation_error",
    "message": "One or more fields are invalid.",
    "details": [{ "field": "firmId", "message": "is required" }]
  }
}
```

`details` is present only for validation errors. Error messages never contain
token material.

## Session lifecycle

Statuses: `awaiting-transfer`, `connected`, `scheduling`, `booked`, `failed`,
`escalated`, `expired`, `cancelled`. v1 implements these transitions:

- create → `awaiting-transfer`
- successful redeem (token or demo connect) → `connected`
- assistant-reported outcome → `booked` | `failed` | `escalated`
  (see [demo-bridge.md](demo-bridge.md); `booked` is reported only after the
  calendar confirms the appointment — never inferred from connection)
- receptionist cancellation → `cancelled`
- expiry → `expired`

The remaining statuses are reserved so later transitions can be added without
changing this contract. Expiration is evaluated when a session is accessed;
after expiry, no caller context is returned.

## Single-use behavior

A token can be redeemed exactly once. Concurrent redemption attempts for the
same token result in exactly one success; the rest receive `409 Conflict`. See
the [server README](../../server/README.md) for how this is guaranteed.

## Current limitations (pilot prerequisites, not hidden defects)

- Sessions are stored **in memory** and are lost on service restart or
  deployment; a single service instance is required.
- **Creating sessions is not yet authenticated**, and the GuideHerd Console
  page itself is not authenticated. Both are required before production.
- A browser refresh loses the console's active session state; the session
  simply expires server-side.
- Telephony transfer and trusted delivery of the voice-side handoff token are
  not part of this slice; the temporary [demo bridge](demo-bridge.md) covers
  the controlled demonstration only — **no phone transfer occurs**.
- Direct calendar-provider webhook confirmation remains deferred hardening;
  the demo trusts the assistant's post-booking outcome report.
- Consultation Summary delivery (Outlook) is a **separate outcome** from the
  appointment booking; a mail failure never reverses a booking. PDF rendering
  of the summary is deferred.
