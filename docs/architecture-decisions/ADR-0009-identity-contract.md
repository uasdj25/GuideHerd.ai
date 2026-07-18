# ADR-0009: The GuideHerd Identity Contract

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 9, 10), ADR-0002
(session-based handoffs), ADR-0007 (Extension Framework — which reserves
Identity as a contract family), ADR-0005/ADR-0008 (the registry and
configuration patterns this ADR reuses)

## Context

GuideHerd's only authentication was a single shared secret inspected
directly by the demo-bridge routes, and the `server.js` security notice has
been explicit since Slice 3: the platform needs real authentication before
broader production exposure. What it must NOT acquire is a per-integration
zoo of auth checks — the exact drift the Extension Framework exists to
prevent. Identity is named in ADR-0007 §5 as a future contract family;
this ADR is that family arriving.

Deliberately out of scope: OAuth, OIDC, SAML, and any specific enterprise
identity system. Those are **providers** — replaceable implementations that
arrive later behind the contract this ADR fixes. Adopting one today would
weld a provider dialect into Core precisely where the Constitution forbids
it.

## Decision

### 1. Core receives identities, never credentials

The permanent shape (`server/identity/`): business logic receives a
**GuideHerdIdentity** — subject, type (`service`/`user`), display name,
organization scope, GuideHerd-owned roles, and the provider that
authenticated it — and authorizes with `requireRole()`. No business logic
may inspect a bearer token; no endpoint may authenticate directly. The raw
credential is read in exactly one place, the identity middleware, and never
crosses into Core, storage, events, or logs.

### 2. Providers implement the contract; the contract validates every claim

An **Identity Provider** translates credentials into an identity claim.
Canonical validation lives with the contract (ADR-0007 §2): every claim
passes one strict allowlist — unknown keys (token material, provider
payloads) are contract violations, and provenance (`identity.provider`) is
stamped by the middleware, never claimed by a provider.

### 3. One provider today: StaticTokenProvider

Long-lived service tokens defined in the deployment environment
(`GUIDEHERD_STATIC_IDENTITIES`; secrets are never Configuration Store
data), held as SHA-256 digests. The demo bridge secret
(`DEMO_BRIDGE_SECRET`) is absorbed as the `scheduling-assistant` service
identity, so the live integration graduated onto the contract with zero
credential or behavior change — the bridge routes' external semantics
(401/403/503 and the documented `demo_bridge_not_configured` code) are
preserved byte for byte, proven by the untouched pre-existing tests.
Malformed identity configuration refuses to compose the app (the
Operational Store's fail-fast pattern).

### 4. Provider selection is configuration; unknown providers fail loudly

The Configuration Store setting `identity/provider` (namespace pattern from
ADR-0004/0005) names the active provider per organization, defaulting to
`static-token`. An explicitly configured but unregistered provider is a
loud `503 identity_provider_unavailable`. **Authentication succeeds only
through the configured provider** — there is no fallback and no union of
providers; selecting a new provider makes the old provider's credentials
stop authenticating, by construction.

### 5. Session capability credentials are not identities

Handoff and console tokens (ADR-0002) are single-purpose, short-lived
capabilities tied to one session. They deliberately remain outside the
Identity Contract: an identity says *who is calling*; a capability token
says *what one session permits*. Both continue to coexist.

### 6. How enterprise identity arrives later

OAuth/OIDC/SAML-based systems (or any successor) become additional
providers implementing `authenticate(credentials) → identity claim`,
registered and selected per organization through configuration — no route,
workflow, or existing provider changes (ADR-0007 §4). The provider owns
every protocol mechanic; GuideHerd owns the identity vocabulary.

## Consequences

- Future authenticated surfaces (Administration Portal, receptionist
  logins, per-organization service credentials) consume `GuideHerdIdentity`
  and roles; none will ever parse an Authorization header.
- Static tokens are v1-adequate for service-to-service credentials but are
  long-lived bearer secrets: rotation is manual (update the environment,
  redeploy), and the browser-facing console endpoints remain unauthenticated
  — the `server.js` security notice still stands until a user-facing
  provider and login flow arrive through this contract.
- The bridge's `demo_bridge_not_configured` dialect survives as a one-line
  mapping in the route layer, documented as temporary; it dies with the
  bridge.
- Roles are a flat GuideHerd-owned vocabulary today (`scheduling-assistant`
  is the first); richer authorization models grow inside the contract,
  invisible to providers.
