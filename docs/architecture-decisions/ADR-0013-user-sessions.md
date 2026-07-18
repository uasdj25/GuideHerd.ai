# ADR-0013: GuideHerd User Sessions

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 9), ADR-0009
(Identity Contract), ADR-0010 (Authorization — which recorded receptionist
login as the required milestone), ADR-0007 (Extension Framework)

## Context

ADR-0009 gave the platform per-request identity for services (bearer
credentials); ADR-0010 classified the Reception Console's operations as
public-by-design *until a user-facing login arrived*. This ADR is that
arrival: the permanent framework for authenticated browser users —
deliberately NOT an OAuth, OIDC, or Microsoft Entra implementation.
Those are provider dialects; what is permanent is who owns the session.

## Decision

### 1. Providers establish identity; GuideHerd establishes the session

A **User Authentication Provider** answers one question — "do these login
credentials identify a GuideHerd user, and who?" — with a GuideHerd
identity claim, validated by the same contract as every identity in the
platform (ADR-0009: strict allowlist, provenance stamped, provider can
never loosen it). Everything after the claim is GuideHerd's alone:
session creation, validation, expiration, invalidation, rotation,
organization-membership verification, and authorization (ADR-0010). No
provider artifact — access token, cookie, claim set — ever becomes a
session by itself, and provider tokens never reach the browser.

Core knows no OAuth, OIDC, Graph, Entra, Google, Authentik, Auth0, or
Keycloak. The active provider is deployment configuration
(`GUIDEHERD_USER_AUTH_PROVIDER`); an unregistered configured provider
fails login loudly. Adding an enterprise provider is one implementation +
one registration + configuration — proven in tests by swapping providers
with zero Core change. Mapping provider groups to GuideHerd roles is
future configuration inside the provider boundary; claims carry GuideHerd
role names, and only the authorization policy decides what roles permit.

### 2. The first provider is a development provider — deliberately

`dev-user` authenticates operator-provisioned opaque keys from the
deployment environment (`GUIDEHERD_DEV_USERS`; SHA-256 digests only; not
password authentication, which stays out of scope). It exercises the
complete flow — credential → claim → session → authorization — with zero
external infrastructure and full determinism, so the architecture is
finished before Microsoft Entra (or any enterprise IdP) arrives as
"simply another provider."

### 3. Session model

Sessions are opaque GuideHerd tokens (`gh_usession_` + 256-bit random),
delivered ONLY as an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie
and stored server-side as SHA-256 hashes. Browser JavaScript can never
read the credential; a store leak reveals nothing replayable. Validation
is server-side on every request; expiry is absolute (default 12h — the V1
receptionist figure, since a receptionist may sign in before a shift and
shifts plus lunch, overtime, and handoff coverage routinely exceed eight
hours; overridable via `GUIDEHERD_USER_SESSION_TTL_SECONDS`) and lazy;
sliding expiration remains deliberately out of scope. Logout invalidates
server-side and clears the cookie; login ALWAYS issues a fresh token and
invalidates any session presented with the login request (fixation
protection). CSRF posture: SameSite=Strict cookies plus JSON-only bodies
(cross-origin form posts cannot carry them) plus the existing exact-origin
CORS allowlist, now with `Access-Control-Allow-Credentials`.

The session store is a small contract; the in-memory implementation is
the reference (a restart logs users out — re-login, no data loss). A
durable PostgreSQL store joins the activation path before multi-instance
production enforcement.

### 4. Console protection is deployment configuration

`GUIDEHERD_CONSOLE_AUTH`: `anonymous` (default — exactly today's
behavior, the ADR-0010 anonymous grants intact) or `required` — the
anonymous grants are withdrawn entirely (fail closed), unauthenticated
console requests receive 401, and authenticated receptionists hold
exactly `handoff:create` + `configuration:read`, organization-scoped: the
`firmId` in a request body is untrusted input checked against the
server-held session, so cross-organization creation and configuration
reads are structurally rejected. An unknown mode refuses to boot.
Capability tokens are unchanged: handoff status/cancel continue to use
the per-session console token (ADR-0002/0010), and service (bridge)
authentication is untouched.

### 5. Audit

`authentication.login`, `authentication.login_failed`, and
`authentication.logout` join the telemetry catalog (Issue #8) — subject,
organization, provider, correlation ID; never credentials, cookies, or
provider claims.

## Activation path (in order, each needing explicit approval)

1. Reception Console login UI (a small form posting to
   `/api/v1/auth/login`; the cookie is HttpOnly — the page stores
   nothing) plus frontend-suite coverage.
2. Provision users (dev provider for the pilot; an enterprise provider
   later) in the deployment environment.
3. Durable session store for multi-instance scale, if needed.
4. Flip `GUIDEHERD_CONSOLE_AUTH=required`.

Until step 4, production behavior is byte-for-byte today's.

## Out of scope (recorded)

MFA, SCIM, SAML, password authentication, self-registration,
invitations, password reset, administration UI.
