# ADR-0010: GuideHerd Authorization

**Status:** Accepted — implemented and governing on `main` (`server/identity/authorization.js`); the role table below matches the shipped policy object exactly (drift corrected 2026-07-18, issue #71).
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 10), ADR-0002
(session-based handoffs / capability credentials), ADR-0007 (Extension
Framework), ADR-0009 (Identity Contract)

## Context

ADR-0009 gave the platform authentication: a credential resolves into a
provider-neutral `GuideHerdIdentity`. What remained ad hoc was
authorization — the demo routes compared a role string, the console routes
relied implicitly on capability tokens, and two browser-facing routes were
anonymous without a recorded decision. Authentication answers *who is
this?* Authorization must answer *what may this identity do, for which
organization and resource?* — once, centrally, fail-closed.

## Decision

### 1. One decision point: the authorization service

`server/identity/authorization.js` exposes
`authorize(principal, permission, context)` — the only place authorization
decisions are made. Routes and services express intent in GuideHerd
permission vocabulary; they never compare role strings, never inspect
provider claims, never implement organization checks independently. Every
unknown — permission, role, capability type, principal shape, scope —
fails closed.

### 2. Permissions are the decisions; roles are bundles

Eight permissions cover the current workflows — `handoff:create`,
`handoff:read`, `handoff:cancel`, `handoff:redeem`, `conversation:connect`,
`conversation:complete`, `summary:read`, `configuration:read` — and the
catalog grows only when a workflow does. The policy (GuideHerd-owned code,
not configuration, not provider data) maps roles to
`{ scope, permissions }`. Four production roles exist (the shipped policy
object in `server/identity/authorization.js`):

| Role | Identity type | Scope | Permissions | Intended surface |
|---|---|---|---|---|
| `scheduling-assistant` | service (bearer credential, ADR-0009) | organization | `conversation:connect`, `conversation:complete`, `summary:read` | the assistant runtime reaching the demo bridge |
| `receptionist` | user (session cookie, ADR-0013) | organization | `handoff:create`, `configuration:read` | the Reception Console (gate intentionally inactive; capability shipped) |
| `operator` | user (session cookie, ADR-0013) | organization | `operations:read` | the Operations Center (read-only) |
| `administrator` | user (session cookie, ADR-0013) | organization | `administration:read`, `administration:write` | the Administration Center |

Roles do not nest: a person needing several surfaces holds several roles.
No production role declares `scope: 'platform'`; a future GuideHerd-operator
persona would be a separate, explicitly platform-scoped role.

Identity providers assert GuideHerd **role names**; only the policy decides
what a role permits. An IdP claim therefore can never directly become a
business authorization decision — a compromised or misconfigured provider
can at worst assert roles whose reach this policy already bounds.

### 3. Organization scope is enforced structurally; platform scope is explicit

An organization-scoped role acts only where
`identity.organizationKey === context.organizationKey`. An identity
*without* an organization key holding an organization-scoped role is
**denied** — absence of scope never widens access. Platform reach exists
only where a role mapping declares `scope: 'platform'`; no production role
does. The bridge identity absorbed from `DEMO_BRIDGE_SECRET` is now
organization-scoped to the demo firm. Organization identifiers arriving in
URLs and bodies are untrusted input: they become the *context* the
authenticated identity is checked against, never a grant.

Every denial — missing permission, wrong tenant, wrong resource — is the
same generic `403 forbidden`. An authorization failure never reveals
whether another organization's resource exists.

### 4. Capability credentials stay, with pinned grants

Handoff and console tokens remain session capability credentials
(ADR-0002/0009), not identities. The repository verifies the credential
itself (constant-time hash, single-use/expiry state machine); the
authorization layer pins what each capability may do:

| Capability | Grants | Resource |
|---|---|---|
| handoff token | `handoff:redeem` | exactly its own session |
| console token | `handoff:read`, `handoff:cancel` | exactly its own session |

A capability can never reach another session or any broader scope.

### 5. Route classification (complete)

| Route | Classification |
|---|---|
| `OPTIONS *` (CORS preflight) | public by design |
| `GET /api/v1/firms/:firmId/scheduling-options` | **public by design** — explicit anonymous grant (`configuration:read`); the console renders it without a login |
| `POST /api/v1/handoffs` | **public by design, explicitly deferred** — anonymous grant (`handoff:create`) until user login arrives; contained by the per-organization prepared-session cap (below) |
| `POST /api/v1/handoffs/redeem` | capability token (`handoff:redeem`) |
| `GET /api/v1/handoffs/:id` | capability token (`handoff:read`) |
| `DELETE /api/v1/handoffs/:id` | capability token (`handoff:cancel`) |
| `POST /api/v1/demo/connect` | GuideHerd Identity (`conversation:connect`, org-scoped) |
| `POST /api/v1/demo/outcome` | GuideHerd Identity (`conversation:complete`, org-scoped) |
| `GET /api/v1/demo/summary/latest` | GuideHerd Identity (`summary:read`, org-scoped) |

No route is *accidentally* anonymous: the two public routes exist as
explicit anonymous grants in the policy, in one reviewable place.

### 6. The anonymous create route: risk and containment

`POST /api/v1/handoffs` accepts caller PII and mints capability tokens
without authentication, because the Reception Console has no login and a
secret embedded in browser JavaScript would be no secret at all. The
precise risk is anonymous abuse: unbounded PII injection and session
flooding. Containment shipped now: strict validation (existing), 16KB body
cap (existing), 10-minute session expiry (existing), and a new
**per-organization cap on concurrently prepared sessions**
(`GUIDEHERD_MAX_PREPARED_SESSIONS`, default 20 →
`429 too_many_prepared_sessions`). The cap is enforced ATOMICALLY by the
repository: one synchronous check-and-insert pass in memory; in
PostgreSQL a transaction-scoped advisory lock keyed by the organization
(`pg_advisory_xact_lock(namespace, hashtext(org))`) serializes
same-organization creates across all API instances, making the count and
insert one atomic unit — the limit is hard, while unrelated organizations
are never serialized against each other. Expired, cancelled, connected,
and terminal sessions never consume capacity.
The remaining requirement — receptionist login through a
user-facing identity provider (ADR-0009) — is deliberately deferred and
remains a production milestone before broader exposure.

### 7. Audit

Every authorization denial emits one structured audit event; successes are
audited only on low-frequency privileged operations (the identity-protected
demo routes), never on console polling. Events carry decision facts only —
subject, identity type, organization key, permission, resource type,
session id, result. Never: bearer or capability tokens, provider claims,
request payloads, caller names/emails/phones, secrets.

### 8. Future identity systems

Google, Microsoft Entra, Authentik, Auth0, Okta, and OIDC/SAML systems
arrive as Identity Providers behind ADR-0009's contract, mapping their
external groups to GuideHerd role names. This ADR is why that is safe:
whatever a provider asserts, the reach of every role is bounded by the
GuideHerd-owned policy, organization scoping is structural, and platform
scope cannot be conferred by a provider claim.

## Consequences

- Business code expresses intent (`authorize(principal, 'handoff:cancel',
  context)`) and cannot broaden access by accident; new routes fail closed
  until the policy grants them.
- The live workflows are unchanged: the ElevenLabs assistant keeps its
  credential and exactly its scheduling permissions; the Reception Console
  keeps its capability-token flow; the demo remains functional.
- No policy language, external policy engine, or database-backed permission
  editor: the policy is a small reviewed code object. If per-customer
  authorization configuration is ever needed, it gets its own ADR.
- The prepared-session cap introduces the platform's first 429; operators
  can raise it per deployment without a deploy of code changes.
