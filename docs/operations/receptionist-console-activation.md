# Runbook: Activating Authenticated Receptionist Access

**Applies to:** Reception Console (`/receptionist/`)
**Architecture:** ADR-0013 (User Sessions), ADR-0010 (Authorization)
**Issue:** #58
**Status of this runbook:** the console-side implementation is complete and
verified locally. **Steps 3–5 below are unperformed and require explicit human
approval.** Production is still running `GUIDEHERD_CONSOLE_AUTH=anonymous`.

---

## What this activates

Authenticated receptionist operation of the Reception Console. Receptionists
sign in through the existing User Sessions architecture and operate under the
existing org-scoped `receptionist` role.

**This introduces no new authentication architecture.** Session issuance,
rotation, expiry, the HttpOnly host-only `gh_session` cookie, the user-auth
provider registry, the `dev-user` provider, and the `receptionist` role all
shipped with ADR-0013/ADR-0010. This runbook turns them on.

### The one-variable property

The console never learns the deployment's auth mode. It reacts to the server:
any console operation answered with `401` means a session is required, so the
sign-in surface is presented. Under `anonymous` that path never triggers.

The practical consequence — and the reason the flip is safe — is that
**activation and rollback are a single server environment variable with no
client release**. The same console build serves both postures.

---

## Preconditions

- [ ] #52 (Design System migration) and #58 (this work) are merged and deployed.
- [ ] The deployed console is verified working in its current `anonymous` posture.
- [ ] A maintenance window is agreed. The flip requires a **service restart**
      (`GUIDEHERD_CONSOLE_AUTH` is read once at boot) and will sign out nobody
      — but it immediately gates every anonymous console user.
- [ ] Someone with Railway environment access is present for the whole window.

---

## Step 1 — Provision receptionist users

Users are provisioned as deployment configuration through the active user-auth
provider. Today that is `dev-user` (`GUIDEHERD_USER_AUTH_PROVIDER` defaults to
`dev-user`).

Set `GUIDEHERD_DEV_USERS` to a JSON array. Each entry:

```json
[
  {
    "key": "<opaque credential, at least 16 characters>",
    "subject": "jane-doe",
    "displayName": "Jane Doe",
    "organizationKey": "martinson-beason",
    "roles": ["receptionist"]
  }
]
```

Validation is fail-fast at boot: `key` must be a string of **≥16 characters**,
`subject` and `organizationKey` must be non-blank, and `roles` must be
non-empty. A malformed entry prevents the service from starting.

**Generating credentials.** Use a high-entropy random value, for example
`openssl rand -base64 32`. The server stores only a SHA-256 digest; the raw
key is never retained. Deliver each credential to its receptionist over a
channel your firm already trusts for secrets — never email it in plaintext.

**Roles.** Use exactly `["receptionist"]`. That role grants precisely
`handoff:create` + `configuration:read`, organization-scoped — exactly the two
console operations and nothing more. Do not add `operator` or `administrator`
to a receptionist; those are separate personas by design (ADR-0010 §2).

**Organization.** `organizationKey` must match the firm's configured
organization. It is the authority for org isolation: the `firmId` in any
request body is untrusted input checked against the server-held session, so a
receptionist structurally cannot act on another firm.

> **Note on the current provider.** `dev-user` authenticates operator-provisioned
> opaque keys — it is deliberately *not* password authentication. Rotating a
> receptionist's credential means editing `GUIDEHERD_DEV_USERS` and restarting.
> There is no self-service reset. This is a recognized limitation of the pilot
> provider, not of the architecture: an enterprise IdP (Entra, Google, Okta)
> slots into the existing registry without touching Core. See "Recurring manual
> work" below.

---

## Step 2 — Verify BEFORE flipping (still `anonymous`)

Do this while the floor is still `anonymous`, so a mistake costs nothing.

- [ ] Restart the service so `GUIDEHERD_DEV_USERS` is loaded.
- [ ] Confirm the console still operates anonymously — unchanged for customers.
- [ ] Confirm the `user-authentication` health capability reports the expected
      number of provisioned users.
- [ ] Sign in on the console with a provisioned credential. Under `anonymous`
      the gate is not shown, but the header identity chip should appear after
      a successful `POST /api/v1/auth/login`, proving the credential, the
      organization, and the role resolve correctly.
- [ ] Sign out and confirm the identity chip clears.

**Do not proceed unless every provisioned receptionist has been verified this
way.** After the flip, an unverified credential is an outage for that person.

---

## Step 3 — Flip to `required`  ⚠ HUMAN APPROVAL REQUIRED

```
GUIDEHERD_CONSOLE_AUTH=required
```

Restart the service. Only `anonymous` and `required` are accepted; any other
value refuses to boot (fail-closed by design).

Effects, immediately and simultaneously:

1. The two ADR-0010 anonymous grants (`handoff:create`, `configuration:read`)
   are **withdrawn entirely** — the policy's anonymous grant list becomes empty.
2. `GET /api/v1/firms/:firmId/scheduling-options` and
   `POST /api/v1/handoffs` return `401` without a valid session.
3. The console presents its sign-in surface to anyone not signed in.

Unchanged by the flip: handoff status/cancel continue to use the per-session
console capability token (ADR-0002/0010), and service (bridge) authentication
is untouched. The Operations Center and Administration Center were already
session-gated regardless of this variable.

---

## Step 4 — Verify AFTER flipping

- [ ] A signed-out visitor sees the sign-in card, not a connection error.
- [ ] `GET /scheduling-options` and `POST /handoffs` return `401` when signed out.
- [ ] A receptionist signs in and completes a full handoff end to end.
- [ ] The header shows `<display name> — <organization>` and Sign out works.
- [ ] A wrong credential produces the calm branded message and does **not**
      reveal whether the user exists.
- [ ] Cross-organization access fails: a receptionist from firm A cannot create
      a handoff for firm B (expect `403`).
- [ ] Telemetry shows `authentication.login` / `authentication.logout`, and
      `authentication.login_failed` for a deliberate bad attempt — carrying no
      credentials, cookies, or provider claims.
- [ ] No surface silently retains anonymous access.

---

## Step 5 — Rollback (rehearse this BEFORE step 3)

```
GUIDEHERD_CONSOLE_AUTH=anonymous
```

Restart. This restores exactly the pre-flip posture: the ADR-0010 anonymous
grants return, and the console operates anonymously as it does today. No client
release, no data migration, no schema change — one variable and a restart.

**Rehearse the rollback before the flip is considered final**, per #58's
acceptance criteria: flip to `required`, verify the gate appears, roll back to
`anonymous`, verify anonymous operation returns. Only then perform the real flip.

---

## Known operational characteristics

**Sessions are in-memory.** The session store is the in-memory reference
implementation, so **a service restart signs everyone out**. Re-login is the
only consequence — no data is lost, and a prepared handoff continues on its own
capability token. A durable PostgreSQL session store is on the ADR-0013
activation path and should land before multi-instance production enforcement.
With more than one API instance, in-memory sessions will not work: a
receptionist's session lives on exactly one instance.

**Session TTL is absolute** — 8 hours by default
(`GUIDEHERD_USER_SESSION_TTL_SECONDS`), not sliding. A receptionist mid-shift
will be signed out at the 8-hour mark regardless of activity. The console
handles this gracefully: the caller's entered details are preserved behind the
gate so signing back in resumes rather than restarts the work. Consider whether
8 hours matches the firm's shift length before the flip.

**Cookies are `Secure` + host-only.** Sign-in works only over HTTPS and only on
the exact API host. Local development over plain HTTP will not persist a
session.

---

## Recurring manual work → future Administration capabilities

Recording these deliberately, per GuideHerd practice of treating recurring
manual work as future platform capability rather than permanent toil:

| Manual work today | Future capability |
|---|---|
| Editing `GUIDEHERD_DEV_USERS` + restart to add/remove a receptionist | User management in the Administration Framework (ADR-0015) |
| Credential rotation by editing environment configuration | Self-service credential rotation, or an enterprise IdP |
| Out-of-band credential delivery | Invitation flow (explicitly out of scope in ADR-0013) |
| Restart to change auth posture | Per-organization tighten-only console auth (deferred by ADR-0013 review) |

The provider registry means adopting Entra/Google/Okta later is one provider
implementation plus one registration — no Core change and no re-run of this
runbook's architecture.
