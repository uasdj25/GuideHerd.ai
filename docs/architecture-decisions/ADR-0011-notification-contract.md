# ADR-0011: The GuideHerd Notification Contract

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 5, 9, 10),
ADR-0004 (configuration store), ADR-0005 (conversation events — the
trigger seam), ADR-0006 (Operational Store — durable idempotency),
ADR-0007 (Extension Framework — Notifications is a named contract
family), Issue #8 (operational telemetry and failure classification)

## Context

Customer-facing appointment communication was owned by whichever provider
happened to touch the moment: the assistant's external calendar tool
books an appointment, and that calendar provider emails the attendee with
its own timing, content, and branding. GuideHerd — the platform whose
value is that the customer experience is coherent — had no notification
capability at all: the only mail it sent was the firm-facing Consultation
Summary.

Issue #18 fixes the ownership: **GuideHerd decides when notifications are
sent, why, what they say, who receives them, and which provider delivers
them. Providers only deliver.**

## Decision

### 1. Core expresses intent through the Notification Contract

`server/notifications/` is the permanent boundary. Core builds a
**NotificationRequest** — GuideHerd type, organization, recipient,
appointment facts, idempotency key, locale — under a strict allowlist
(unknown keys rejected; provider payloads and stray PII can never ride
along). Core never composes provider payloads and knows nothing of Graph,
SMTP, Outlook, Twilio, Teams, or SMS.

Four notification types exist: `appointment-confirmation`,
`appointment-cancellation`, `appointment-rescheduled`,
`appointment-reminder`. All four validate, render, and deliver through
the same pipeline; the platform currently has exactly one trigger moment
(a booked conversation outcome → confirmation, below). The other types'
triggers arrive with the workflows that produce those moments.

### 2. Templates are provider-independent; branding belongs to GuideHerd

Rendering (`templates.js`) turns canonical data into subject, HTML, and
plain text. No HTML in business logic; every human string lives in a
locale-keyed catalog (en-US today; a locale is an entry, not code). All
values are HTML-escaped. Notifications present as communications **from
the law firm**, delivered by GuideHerd: no calendar-provider, mail-API,
or implementation branding anywhere — tests scan for it.

Branding (`branding.js`) resolves per organization: sender name defaults
from the Configuration Store organization record; the
`notifications/branding` setting can override sender name, accent color,
logo (https only), footer, and office contact block. This is the
architecture for future customer customization; a branding
administration surface is deliberately not built.

### 3. Delivery is exactly-once per notification key

A `notificationKey` (e.g. `appointment-confirmation:<sessionId>`)
identifies one logical customer notification, forever. The delivery
store claims the key BEFORE any provider call — duplicates (retries,
replayed workflows, concurrent API instances) fail to claim and are
suppressed without a provider call. `failed` may be re-claimed later;
**`sent` is final and never re-claimed**. Two implementations share the
contract: in-memory (reference) and PostgreSQL
(`notification_deliveries`, migration 0002 — one atomic conditional
INSERT/UPDATE, multi-instance safe), following the ADR-0006 claim
pattern.

**Key construction rule (binding on trigger authors):** a key is
`<type>:<identifier of the logical communication event>` — the type
prefix namespaces suppression (a confirmation can never suppress a
cancellation), and the identifier names the business EVENT, not merely a
resource and never a send attempt. Confirmation keys on the session id
alone are correct because first-terminal-outcome-wins (ADR-0006)
guarantees at most one booking per session. Reschedules and reminders are
MULTIPLE legitimate events per appointment: their keys must carry the
occurrence's own discriminator (a reschedule event id; a reminder
schedule slot), supplied by the workflow that produces the moment. Never
derive a key from a send-time timestamp (defeats idempotency) or content
(a template change would re-send).

**Trigger transport note:** today's trigger rides the in-process
conversation-events seam (ADR-0005 §5) — fire-and-forget, at-most-once;
a crash between outcome commit and send loses the notification rather
than duplicating it. That bias is deliberate while the feature is
config-gated. The permanent driver is durable operational state (the
operational-events/outbox mechanism ADR-0006 deferred) swept
at-least-once — safe to adopt precisely because delivery claims already
make redelivery idempotent; only triggers.js changes when it arrives.

Provider-level retries reuse the Issue #8 machinery and its
duplication-safety rule: only provably-not-accepted failures retry
(429, 503, connection-phase); timeouts/other 5xx are ambiguous and never
retried — the claim state machine is the retry-later path.

### 4. Providers are registered, selected by configuration, and fail loudly

The first provider is **Microsoft Graph Email**
(`graph-email-provider.js`): it translates one rendered, branded message
into a Graph sendMail call, classifies failures into the GuideHerd
taxonomy, and reports the neutral `{ status }`. The organization's
provider comes from the `notifications/provider` setting (default
`graph-email`); an explicitly configured but unregistered provider fails
loudly and records a re-claimable `failed` — never a silent substitute.
A future provider (SMTP, Twilio SMS, Teams, …) is: one implementation of
`deliver()`, one `register()` call, one configuration value. Core is
untouched, by construction — the tests demonstrate it with a synthetic
provider selected via configuration.

Sender identity note: Graph sends from the configured mailbox
(`NOTIFICATION_MAILBOX`, falling back to `SUMMARY_MAILBOX`); presenting a
firm-named sender is a mailbox/domain deployment concern, not a payload
trick.

### 5. The confirmation trigger — DISABLED BY DEFAULT, deliberately

The booked-confirmation trigger subscribes to `conversation.completed`
(the ADR-0005 events seam, used exactly as designed) and requires the
per-organization setting `notifications/appointment-confirmation:
{ "enabled": true }`. Without it the trigger is inert and current
customer behavior is preserved exactly. See §7 for why.

### 6. Telemetry

Delivery emits `notification.delivered` / `notification.delivery_failed`
/ `notification.suppressed` through the Issue #8 event surface — safe
identifiers only (type, key, organization, correlation ID, provider,
provider request id); never message content, recipient addresses, or
names.

## 7. The calendar-provider reality (Cal.com findings)

Inspection finding: **GuideHerd has no Cal.com integration of any kind.**
The platform holds no Cal.com credentials, API calls, or webhooks; the
only repository references are as an example provider name in ADR-0007
and the Constitution. Booking happens inside the external assistant's
own calendar tool, and the calendar provider sends its own attendee
emails under its own account configuration — a channel this platform
cannot observe or suppress programmatically.

Consequences, per the no-guessing rule:

- Whether Cal.com's attendee emails can be disabled is a **Cal.com
  account/event-type configuration question**, answerable only in the
  Cal.com dashboard — an external configuration change that is out of
  scope here and requires explicit approval.
- Until those attendee emails are confirmed disabled for a firm,
  enabling GuideHerd's confirmation would DOUBLE-NOTIFY the customer.
  Hence §5: the trigger ships dark, and current behavior is unchanged.
- **Recommended sequence to make GuideHerd the sole sender:**
  1. Confirm/disable attendee emails in the Cal.com account for the
     firm's event type (external config change, needs approval).
  2. Flip `notifications/appointment-confirmation` for the firm.
  3. Long term (ADR-0005/0007 direction): booking moves behind a
     GuideHerd Scheduling extension that calls the calendar provider
     API-side with standard emails disabled — ownership then holds
     structurally rather than by account configuration.

## Consequences

- GuideHerd owns the notification experience end to end; the customer
  reads firm-branded communication regardless of which provider
  delivers it.
- Retries, duplicate outcome reports, crashes, and multi-instance
  replays cannot double-notify a customer — proven under concurrent
  retry in both store implementations.
- The Consultation Summary mailer remains on its existing boundary
  (deliberately untouched); migrating it onto the Notification Contract
  is natural follow-up work, at which point the platform has exactly one
  Graph implementation.
- Reminder notifications additionally need a scheduler (no timer
  infrastructure exists in the platform); that arrives with its own
  ticket.
