# Runbook: Activating Authenticated Receptionist Access

**Applies to:** Reception Console (`/receptionist/`)
**Architecture:** ADR-0013 (User Sessions), ADR-0010 (Authorization)
**Issue:** #58 (implementation), #61 (production activation)
**Status of this runbook:** **ACTIVATED IN PRODUCTION on 2026-07-20 (GitLab #61).**
Production runs `GUIDEHERD_CONSOLE_AUTH=required` — the Reception Console requires
receptionist sign-in and unauthenticated console requests receive 401. The steps
below remain the canonical, reusable procedure (and rollback) for any future
deployment or re-run.

### Activation record (2026-07-20, GitLab #61)

- **Change:** set `GUIDEHERD_CONSOLE_AUTH=required` in Railway production
  (`truthful-eagerness` / `GuideHerd.ai` / `production`) — the only configuration
  change; `GUIDEHERD_DEV_USERS` and everything else unchanged; no code change.
- **Verified:** unauthenticated `scheduling-options` → 401; the branded sign-in gate
  is shown without a session; authenticated receptionist sign-in loads the console;
  practice areas, attorneys, and consultation types load; a normal handoff completed
  end to end; `/healthz` = `/readyz` = 200; clean boot on deployment.
- **Rollback:** remove `GUIDEHERD_CONSOLE_AUTH` (or set `anonymous`) and redeploy.

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

**Preferred (#65):** provision users live through the Administration screen's
Users card — no deployment change, no restart, credential issued and shown
once at creation. This requires ONE administrator to exist first; that
first administrator is bootstrapped as deployment configuration below.
Deployment-provisioned (`GUIDEHERD_DEV_USERS`) users continue to work and
remain the bootstrap/recovery path — both sources authenticate through the
same provider, and **deployment wins**: a deployment-provisioned identity
can never be governed, re-roled, deactivated, or shadowed from the
Administration screen. Whatever happens in the user directory, the
bootstrap administrator's credential keeps working — that identity is the
recovery tier, changeable only by deployment configuration.

Deployment bootstrap: users are provisioned through the active user-auth
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

### The session-store operating boundary — LIFTED (#64)

**Login sessions are durable under
`GUIDEHERD_OPERATIONAL_PROVIDER=postgres`** — the provider production runs.
The durable store (operational migration `0007-user-sessions`) holds
SHA-256 token hashes and validated identities only, preserves the full
ADR-0013 lifecycle (absolute lazy expiry, rotation/fixation protection,
immediate logout invalidation — re-proven by the shared lifecycle suite on
the real database), and makes sessions valid across instances: restarts no
longer sign users out, and revocation on one instance is immediately
visible on every other.

The historical single-instance constraint existed only because sessions
were in process memory; with the `memory` provider (development, tests)
that behavior is unchanged and remains the documented reference. Sticky
sessions never became the architecture — the durable store did, exactly as
this section required.

**Session lifetime is absolute — 12 hours by default**
(`GUIDEHERD_USER_SESSION_TTL_SECONDS`), not sliding. A session ends 12 hours
after it was *issued*, regardless of activity.

12 hours is the V1 receptionist figure: a receptionist may sign in before a
shift, and shifts plus lunch, overtime, and handoff coverage routinely exceed
eight hours. The intent is that a normal shift never hits the boundary
mid-call.

The console handles expiry gracefully regardless — the caller's entered details
are preserved behind the gate, so signing back in resumes rather than restarts
the work. Confirm 12 hours covers the firm's longest realistic shift before the
flip, and override per deployment if not.

**Cookies are `Secure` + host-only.** Sign-in works only over HTTPS and only on
the exact API host. Local development over plain HTTP will not persist a
session.

---

## Recurring manual work → future Administration capabilities

Recording these deliberately, per GuideHerd practice of treating recurring
manual work as future platform capability rather than permanent toil:

| Manual work today | Future capability |
|---|---|
| ~~Editing `GUIDEHERD_DEV_USERS` + restart to add/remove a receptionist~~ | **Shipped (#65):** user management in the Administration Framework — add/deactivate/roles live, immediate revocation |
| ~~Credential rotation by editing environment configuration~~ | **Shipped (#65):** administrator-issued rotation from the Users card (enterprise IdP remains future) |
| Out-of-band credential delivery | Invitation flow (explicitly out of scope in ADR-0013) |
| Restart to change auth posture | Per-organization tighten-only console auth (deferred by ADR-0013 review) |

The provider registry means adopting Entra/Google/Okta later is one provider
implementation plus one registration — no Core change and no re-run of this
runbook's architecture.
