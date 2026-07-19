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

**What DJ must do to unblock (one-time, ~15 minutes with an existing
Microsoft 365 tenant):**

1. In Entra ID: an app registration with **`Mail.Send` (Application)**
   permission, **admin-consented**. Strongly recommended: scope it to the
   sending mailbox only via an Exchange `ApplicationAccessPolicy`, so the
   credential cannot send as anyone else.
2. Choose the sending mailbox (GuideHerd-controlled, e.g.
   `notifications@guideherd.ai`) and the summary recipient (the firm's
   intake address, or DJ's for the pilot).
3. Enter the five values **directly in Railway's protected variables UI**
   — never via chat, files, or shell.
4. Redeploy (variables are read at boot).

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

## Rollback

Remove (or blank) any ONE of the five variables in Railway and redeploy:
the mailer disables, deliveries record `not-configured`, bookings continue
unaffected. No data migration; fully reversible.

## Credential rotation

**Owner: DJ** (holder of the Entra tenant). Procedure: create a new client
secret in the app registration → update `MS_CLIENT_SECRET` in Railway →
redeploy → delete the old secret in Entra. Rotate immediately if the value
is ever exposed anywhere outside Railway's variable store; calendar
rotation per the tenant's policy (Entra secrets expire — set ≤ 24 months
and diarize).

## Microsoft permission requirements (known)

- Graph **`Mail.Send` — Application** permission with tenant admin consent.
- The token request uses `client_credentials` with the `.default` scope
  (already implemented; no delegated flow, no user sign-in).
- Exchange `ApplicationAccessPolicy` restricting the app to the sending
  mailbox: not required by the code, strongly recommended for least
  privilege.
