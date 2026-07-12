# Context Handoff API (v1)

Passes short-lived caller context from the Receptionist Portal to the GuideHerd
Scheduling Assistant. The receptionist qualifies a caller, GuideHerd creates a
**Scheduling Session** and a single-use **handoff token**, and the assistant
redeems that token to receive the minimum context it needs to book a
consultation.

This contract uses GuideHerd domain language only. No vendor concepts (voice,
scheduling, calendar, or model providers) appear anywhere in it.

> **Scope:** scheduling context only. This API does not accept or store legal
> intake, SSNs, payment details, documents, or case facts.

## Security assumptions

- The handoff token is a **bearer credential**. It is single-use and expires
  **10 minutes** after creation.
- Tokens are generated from a cryptographically secure source and are stored
  only as a hash. The raw token is returned once, on creation.
- Tokens are accepted **only in the request body**, never in the URL.
- Tokens are never logged and never appear in error messages.
- **Authentication and authorization are NOT implemented in v1** and are a
  required production prerequisite. These endpoints must be protected (service
  auth + network restrictions) before any real deployment.

## Browser access (CORS)

Browser callers must come from an allowlisted origin, configured with the
`CORS_ALLOWED_ORIGINS` environment variable (comma-separated). The default
allowlist is:

- `https://guideherd.ai`
- `http://localhost:8080`

Rules:

- A wildcard (`*`) origin is **never** allowed; wildcard entries are ignored.
- Preflight `OPTIONS` requests are supported.
- Only `POST` and `OPTIONS` methods are permitted.
- Only the `Content-Type` request header is permitted.
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
| `caller.phone` | no | Caller phone (stored as provided; not parsed) |
| `scheduling.attorneyId` | yes | Attorney the caller wants |
| `scheduling.practiceAreaId` | no | Practice area |
| `scheduling.consultationTypeId` | yes | Consultation type |
| `scheduling.existingClient` | no | Boolean; defaults to `false` |
| `handoff.createdByUserId` | no | Receptionist who created the handoff |
| `handoff.source` | yes | Where the handoff originated |
| `handoff.mode` | yes | Handoff mode (e.g. live transfer) |

String fields are trimmed; blank required values are rejected. Each string field
has a maximum length to reject oversized payloads.

**Example request**

```json
{
  "firmId": "martinson-beason",
  "caller": { "fullName": "David Jones", "phone": "+14044232676" },
  "scheduling": {
    "attorneyId": "clay-martinson",
    "practiceAreaId": "personal-injury",
    "consultationTypeId": "initial-consultation",
    "existingClient": false
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
  "callerPhone": "+14044232676",
  "attorneyId": "clay-martinson",
  "practiceAreaId": "personal-injury",
  "consultationTypeId": "initial-consultation",
  "existingClient": false,
  "status": "connected"
}
```

The response is deliberately minimal. It does **not** include the receptionist
user ID, handoff source/mode, token metadata, or any vendor-specific data.
Optional values that were not provided are returned as `null`.

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
`expired`, `cancelled`. v1 implements only these transitions:

- create → `awaiting-transfer`
- successful redeem → `connected`
- expiry → `expired`

The remaining statuses are reserved so later transitions can be added without
changing this contract. Expiration is evaluated when a session is accessed;
after expiry, no caller context is returned.

## Single-use behavior

A token can be redeemed exactly once. Concurrent redemption attempts for the
same token result in exactly one success; the rest receive `409 Conflict`. See
the [server README](../../server/README.md) for how this is guaranteed.
