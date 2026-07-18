# GuideHerd Operational Telemetry & Failure Handling

> Implements Issue #8 (MVP Error Handling and Operational Logging). This
> document describes telemetry **generation** and safe failure behavior.
> Persistence and display belong to Issue #22 (Operations Dashboard),
> which will consume the event contract defined here. No new ADR: this
> work implements conventions inside boundaries already fixed by
> ADR-0005–ADR-0010.

## Correlation IDs

One GuideHerd-owned correlation ID exists per inbound request.

- **Header:** `X-GuideHerd-Correlation-Id` — returned on **every**
  response (success, failure, preflight, HTML). Browsers may read it
  (`Access-Control-Expose-Headers`); internal callers may send it
  (allowed in preflight).
- **Inbound (trust model):** every request starts with a freshly generated
  `gh-<24 hex>` ID. A caller-supplied value is only a *candidate*: it must
  match `^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$` (opaque, log-safe) AND the
  request must authenticate as a trusted GuideHerd **service** identity
  through the Identity Contract (ADR-0009) before the candidate is
  adopted. Anonymous requests, browser/console clients, capability-token
  requests, non-service (user-type) identities, and failed authentications
  always keep the generated ID — arbitrary callers can never control
  operational log identifiers, and shape validation applies even to
  trusted services.
- **Propagation:** request log lines, structured events, error envelopes,
  conversation events (`conversation.connected` / `.completed`), the
  outcome/summary pipeline, and the mailer provider boundary.
- **Never:** a session token, bearer token, phone number, email address,
  caller name, or a provider's request id. Provider request ids (e.g.
  Graph `request-id`) are recorded only as the `providerRequestId`
  **secondary** reference in events.

## Error envelope

Every JSON error response has the stable shape:

```json
{ "error": { "code": "<stable_code>", "message": "<generic safe text>",
             "correlationId": "gh-…" } }
```

Connect-facing (assistant/demo-bridge) error responses additionally carry
`error.callerMessage`: calm, provider-free text the Guide can deliver to
the caller. `error.code` remains the Guide's machine-readable branching
signal; the Guide is never expected to read a correlation ID aloud.
Pre-existing public `code` values are unchanged. Unexpected failures are
always `500 internal_error` with a generic message — never exception
text, stack traces, provider names, or HTTP internals.

## Error taxonomy

Closed set, GuideHerd-owned; provider dialects are translated at the
provider boundary and never cross it:

`validation_error · unauthorized · forbidden · not_found · conflict ·
rate_limited · provider_unavailable · provider_timeout ·
provider_authentication_failed · provider_rate_limited ·
provider_rejected_request · transient_internal_failure ·
permanent_internal_failure · unexpected_error`

Domain errors map by stable code (with an HTTP-status fallback; `410` is
treated as a state `conflict`). Provider-boundary failures carry their
category explicitly (`server/telemetry/provider-errors.js`).

## Structured events

Emitted by `server/telemetry/telemetry.js` as single-line JSON on stdout
(Railway convention; query attributes with `@field:value`). Event names
are stable and prefixed `guideherd.`:

request.failed · validation.failed · authorization.denied¹ ·
correlation.failed · provider.unavailable · provider.timeout ·
provider.authentication_failed · provider.rate_limited ·
provider.rejected_request · scheduling.availability_failed² ·
booking.failed² · outcome.failed · summary.generation_failed ·
summary.delivery_failed · retry.attempted · retry.exhausted ·
internal.unexpected_error

¹ primary emission lives in the authorization service (ADR-0010).
² reserved seams: availability/booking execute provider-side today; the
names are fixed for when those operations move in-platform.

**Field allowlist (everything else is dropped, never logged):**
`correlationId, organizationKey, component, operation, severity (as
level), category, retryable, attempt, maxAttempts, httpStatus, provider,
providerRequestId, sessionId, code, errorName, stack, method, path`.

**Components:** `http-api, identity, authorization, configuration-store,
operational-store, handoff, connect, correlation-engine,
scheduling-provider, calendar-provider, email-provider,
communication-provider, internal`.

**Emission policy:** every failed request emits exactly one HTTP-layer
event (`validation.failed` for 400s, otherwise `request.failed`; severity
info < 429 warn < 5xx error), plus deeper events where they occur
(correlation, outcome, summary, provider, retry). Successes emit no
telemetry beyond the existing request log — no noisy success events on
polling. Unexpected internal errors log the error **name** and stack
**frames only** (the message line is stripped — messages can echo request
data).

## Redaction rules (both logs and responses)

Never present: bearer/capability tokens, Authorization headers, API keys
or credentials, raw provider payloads, transcripts/recordings, caller
names, phone numbers, email addresses, legal matter narratives,
unsanitized stack traces. Enforced structurally (the field allowlist and
the sanitizer) and proven by log-scanning tests.

## Retry policy

`server/telemetry/retry.js`: bounded attempts (default 3), short
deterministic backoff, injected sleep (tests never wait), one
`retry.attempted` event per retry and `retry.exhausted` on the final
failure. Classification happens at the provider boundary; a failure is
retried only when it is BOTH transient and **duplication-safe**.

Mailer (Microsoft Graph) — the platform's one outbound provider call:

| Failure | Category | Retried? | Why |
|---|---|---|---|
| 429 | provider_rate_limited | yes | message not accepted |
| 503 | provider_unavailable | yes | message not accepted |
| connect refused / DNS | provider_unavailable | yes | request never left |
| timeout / mid-flight reset | provider_timeout | **no** | Graph may have accepted → duplicate email risk |
| other 5xx | provider_unavailable | **no** | acceptance ambiguous |
| 401/403 | provider_authentication_failed | no | permanent |
| other 4xx | provider_rejected_request | no | permanent |

Ambiguous/permanent failures resolve to `{ status: 'failed' }`; the
Operational Store's summary-delivery **claim** state machine (ADR-0006)
remains the retry-later path, and `sent` finality guarantees a summary is
never re-sent. Outcome recording is idempotent/first-wins (ADR-0006), so
client retry storms cannot create duplicate bookings or conflicting
outcomes — proven under concurrent retry in tests.

## Caller-facing message policy

Connect-facing failures map, by category, to calm generic messages
(`server/connect/caller-messages.js`): no provider names, HTTP details,
exception text, or implementation details, and no identifiers to read
aloud. Browser-facing routes keep their existing envelope (plus
`correlationId`) — the Console renders its own UI copy.
