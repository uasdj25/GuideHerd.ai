# Runbook: Production Email Delivery Activation (#60)

**Capability:** Consultation-summary email via the existing Microsoft Graph
Notification Contract (ADR-0011). Operational activation only — no redesign.
**Status:** Preparation complete; **activation blocked** pending credential
provisioning (see "Current blocker"). Production currently reports the
`notification-provider` capability as `not-configured` and sends nothing.

## Source-verified facts (2026-07-18, code inspection only)

- **Required variables (names only — values live exclusively in Railway's
  protected variable store, never in this repo, reports, or shell output):**
  `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `SUMMARY_MAILBOX`,
  `SUMMARY_RECIPIENT`. Optional: `NOTIFICATION_MAILBOX` (sending mailbox for
  customer-facing types; falls back to `SUMMARY_MAILBOX`).
- **Presence detection** (`server/handoff/mailer.js:101-107`): the mailer is
  enabled only when ALL five are present; otherwise the API runs normally and
  every delivery records `not-configured`. No partial modes.
- **Sender identity** (`graph-email-provider.js`): mail sends via Graph
  `users/<mailbox>/sendMail` with `client_credentials` +
  `https://graph.microsoft.com/.default`. **The From address is the
  configured mailbox** — a deployment fact. The per-firm branding
  `senderName` appears in subject/body copy only; the configured
  `SUMMARY_RECIPIENT` is where the firm-facing summary is delivered.
  Three distinct things: *visible sender name* (branding, body), *actual
  From address* (the mailbox variable), *delivery recipient*
  (`SUMMARY_RECIPIENT`).
- **Triggering outcomes** (`summary-notification.js:161-165`): summaries send
  for EVERY terminal outcome — booked, failed, AND escalated — with durable
  outbox recovery and 'sent'-final idempotency. Covered by the automated
  suite (booked/failed/escalated cases assert generation and delivery
  semantics with a fake mailer; runs green on every merge).
- **Operations Center**: deliveries surface in the notification-deliveries
  view as `sent` / `failed` / `not-configured` / `pending`; the
  `notification-provider` health capability flips from `not-configured` to
  `available` once the mailer is enabled.
- **Confirmations/reminders stay OFF**: `notifications/appointment-confirmation`
  and `scheduler/appointment-reminders` both default `{ enabled: false }`
  per organization; activating summary delivery does not touch them, so no
  double-notification with Cal.com/Outlook attendee email is possible.
- **Failure isolation**: delivery is a separate outcome from booking
  (`mailer.js` contract; asserted in tests) — a mail failure can never
  reverse or invalidate a confirmed appointment.

## What activation now also unlocks (batch 5)

- **Operational alerts (#68)** ride the same delivery path: once mail is
  live, firms that enable alerting get failure emails; until then, alert
  conditions surface as loud telemetry and Operations Center events only.
- The Microsoft 365 sandbox/tenant work is tracked as **#72** (owned
  separately); production credentials remain the owner action below
  regardless of which tenant provides them.

## Current blocker (non-secret, exact)

Activation requires Microsoft Graph application credentials and an
authorized sending mailbox. As of 2026-07-18:

1. **No Microsoft credential values exist in any store this work is
   authorized to read.** Railway (names-only check) has none of the five
   variables; no GuideHerd secret-management interface holding Graph
   credentials is available to this environment.
2. **Creating them is explicitly out of bounds**: provisioning a tenant,
   app registration, mailbox, or any paid resource requires human approval
   and Microsoft-side admin consent that cannot (and must not) be bypassed.

**What the operator must do to unblock (one-time, with an authorized
Microsoft 365 tenant). Verified against official Microsoft docs 2026-07:**

1. **Entra app registration** for the client-credentials (daemon) flow:
   a client secret or (preferred) certificate; tokens acquired with scope
   `https://graph.microsoft.com/.default`. No redirect URI, no signed-in
   user. Application permission — **not** delegated (there is no user).
   ([client-credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow))

2. **Scope the app to the ONE sending mailbox — use RBAC for Applications,
   NOT ApplicationAccessPolicy.** Microsoft has retitled the old page
   "Application Access Policies (legacy)" and states plainly *"New access
   configuration should not use Application Access Policies"* (future
   deprecation + forced migration). The current mechanism is **Exchange
   Online RBAC for Applications**
   ([docs](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)):
   - `New-ServicePrincipal -AppId <appId> -ObjectId <enterprise-app objectId>`
     (use the **Enterprise Applications** object id, not the App
     Registration's).
   - `New-ManagementScope -Name "GuideHerd sender" -RecipientRestrictionFilter "<filter matching only the sending mailbox>"` (or an Administrative Unit).
   - `New-ManagementRoleAssignment -Role "Application Mail.Send" -App <SP> -CustomResourceScope "GuideHerd sender"`.
   - Verify with `Test-ServicePrincipalAuthorization -Identity <SP> -Resource <mailbox>`.
   - **Structural difference from the legacy model:** with RBAC for
     Applications you do **not** also grant `Mail.Send` in Entra — the
     Exchange role assignment IS the grant, and Entra grants + Exchange
     grants form a **union**, so a leftover Entra `Mail.Send` would defeat
     the mailbox scoping (grant tenant-wide send). If the app already has
     the Entra `Mail.Send` grant, remove it.
   - *(Legacy `New-ApplicationAccessPolicy` still functions today and is an
     acceptable stopgap if RBAC is unavailable; if used, note its scope
     principal cannot be a shared mailbox directly — a mail-enabled
     security group is required for that — and changes can take **>1 hour**
     to propagate.)*

3. **Sending mailbox**: must resolve to a real Exchange Online mailbox
   (REST-enabled). A licensed user mailbox is the fully documented path; an
   unlicensed shared mailbox (≤50 GB) is widely used for this but is not
   explicitly documented by Microsoft for app-only send — prefer a licensed
   mailbox for the pilot to avoid ambiguity. Choose the summary recipient
   (the firm's intake address, or the operator's for the pilot).

4. **Propagation:** after consent + role assignment, allow **~30 min to
   ~2 hours** before the send path converges (RBAC cache;
   `Test-ServicePrincipalAuthorization` bypasses the cache and does not
   prove API-path convergence). Do not conclude "broken" before then.

5. Enter the five values **directly in Railway's protected variables UI**
   — never via chat, files, or shell. Redeploy (variables read at boot).

## Verification procedure (after unblocking)

1. Confirm the Operations Center health view shows `notification-provider:
   available` (was `not-configured`).
2. Run one controlled handoff with DJ-owned test contact details through
   the live console → transfer → let the demo bridge report a terminal
   outcome.
3. Confirm the consultation summary arrives at `SUMMARY_RECIPIENT`; check
   sender, subject, body, and formatting.
4. Confirm the Operations Center notification-deliveries row reads `sent`.
5. Record ONLY: date/time, outcome type, delivery status, pass/fail. Never
   the test contact details.
6. Booked/failed/escalated coverage: already proven by the automated suite;
   one live outcome type suffices for the wire-level check.
7. Skim recent non-sensitive logs for the delivery events; verify no
   credential or caller-detail appears (the telemetry allowlist enforces
   this; the check is confirmatory).

## Hardening shipped with #60 (no operator action)

Both Graph transports (the summary mailer and the notification provider)
now bound every request with a timeout (default 10 s): a hung token or
send call can no longer hang outcome recording or delivery draining.
Token-phase timeouts are retried (no mail can have been sent); send-phase
timeouts remain non-retryable (acceptance ambiguous — a duplicate summary
is worse than a delayed one) and resolve to the claim machine's
retry-later path.

## Rollback

Remove (or blank) any ONE of the five variables in Railway and redeploy:
the mailer disables, deliveries record `not-configured`, bookings continue
unaffected. No data migration; fully reversible.

## Credential rotation

**Owner: whoever administers the Microsoft 365 tenant that holds the app
registration** (the production/customer tenant — see ownership assumptions
below; tenant provisioning is #72). Procedure: create a new client secret
(or certificate) in the app registration → update `MS_CLIENT_SECRET` in
Railway → redeploy → delete the old secret in Entra. Rotate immediately if
the value is ever exposed anywhere outside Railway's variable store;
otherwise on the tenant's calendar (Entra secrets expire — set ≤ 24 months
and diarize). Certificates are preferred over secrets for a daemon app.

## Microsoft permission requirements (verified against official docs 2026-07)

- **Application** (not delegated) Graph `Mail.Send`, tenant admin consent
  required — an unattended service has no signed-in user. By default this
  can send as ANY mailbox in the tenant, which is why mailbox scoping is
  mandatory. ([sendMail permissions](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference))
- Token request: `client_credentials` with the `.default` scope (already
  implemented; no delegated flow, no user sign-in).
- **Mailbox scoping via RBAC for Applications** (the current mechanism —
  `ApplicationAccessPolicy` is legacy; see the unblock steps above). Under
  RBAC, the Exchange role assignment is the grant and must NOT be
  duplicated by an Entra `Mail.Send` grant (union semantics defeat
  scoping).

## Tenant and mailbox ownership assumptions (stated plainly)

- **GuideHerd uses Google Workspace / Gmail internally.** Microsoft Graph
  support exists because the pilot firm (Martinson & Beason) uses
  Microsoft 365 — this is provider breadth, not a change to GuideHerd's own
  mail.
- **A Microsoft 365 Developer/trial tenant is suitable for BUILDING and
  validating the adapter**, if the operator qualifies (the E5 developer
  sandbox is no longer open public sign-up — it now requires a Visual
  Studio subscription, partner-program, or Unified/Premier support
  eligibility). It is **not** suitable as anything persistent: the
  subscription lasts up to 90 days and, on expiry, data is deleted after a
  30+30-day grace — the app registration, consent, mailbox, and role
  assignments all vanish and must be re-provisioned in the production
  tenant regardless. Inbound connectors are unsupported in dev tenants.
  ([dev program FAQ](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq))
- **Production activation requires an authorized customer or production
  tenant, a real Exchange Online mailbox, admin consent, and the five
  values entered only through the protected configuration interface.** The
  Microsoft 365 sandbox/tenant provisioning is tracked separately as **#72
  (assigned to Ryan)** and is untouched by this work.
- **No Graph credential and no live production delivery has been configured
  or verified.** #60 remains OPEN after this documentation branch merges,
  until the verification procedure above is actually performed.
