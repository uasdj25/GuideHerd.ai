# ADR-0018: The GuideHerd Scheduler Contract

**Status:** Accepted — implemented and governing on `main`.
**Date:** 2026-07-18
**Relates to:** ADR-0017 (Durable Event Outbox — the reliability model
this reuses and the event source it consumes), ADR-0011 (Notification
Contract — where scheduled communication intents are delivered),
ADR-0016 (Customer Configuration Framework — reminder configuration),
ADR-0006 (Operational Store — the durable substrate), ADR-0007
(extension discipline), ADR-0014 (Operations Center — visibility)

## Context

Nothing in GuideHerd could act at a FUTURE time: every behavior was a
response to a request or an event happening now. Appointment reminders
— promised since ADR-0011 ("reminders additionally need a scheduler")
— are the first of a family: follow-ups, surveys, document requests,
retention campaigns, integration syncs. This ADR establishes the
permanent home for all of them, NOT a reminder emailer: the GuideHerd
Scheduler Contract, whose single responsibility is **execute scheduled
GuideHerd business actions at the correct time**.

## Decision

### 1. The Scheduler Contract

`server/scheduler/scheduler.js` (PostgreSQL store in
`server/operational/scheduled-actions.js`, migration 0004). Producers
schedule ACTIONS; handlers register per action type; the processor
executes what is due. The scheduler is provider-independent by
construction: it knows no email, SMS, Graph, Twilio, Teams, or
ElevenLabs — an action handler states business intent (the reminder
handler speaks only to the Notification Contract), and delivery remains
a Notification/Communication responsibility. The scheduler decides one
thing: *what business action becomes eligible now?*

### 2. The scheduled action

Every action carries: `actionKey` (unique identifier AND structural
dedupe boundary — scheduling an existing key is a conflict-free no-op),
`actionType` (selects the handler), `organizationKey`, optional
`sessionId`, `correlationId` (Issue #8 thread), `runAtMs`, optional
`expiresAtMs`, retry metadata (`attempts`, `nextAttemptAtMs`), and
`state`. Payloads carry safe GuideHerd facts only — never tokens, PII,
or provider payloads (tested by scans). **Scheduling is always UTC
internally**; organization timezones are presentation concerns
(templates format appointment times in the appointment's zone; consoles
format for the viewer).

### 3. Lifecycle and guarantees — precise

`pending → ready → processing → completed | failed → retry… `, plus
`cancelled` (producer withdrew it) and `expired` (`expiresAt` passed
unexecuted — worthless work dies instead of running late). `ready` is
the presented state of a due, unclaimed pending action; the claim
transitions pending→processing in one atomic write.

The reliability model is the Durable Event Outbox's, REUSED not
reinvented: atomic conditional claims (at most one concurrent executor
per action across restarts and PostgreSQL instances), bounded retries
(default 5) with deterministic clock-based backoff, terminal `failed`
on exhaustion, stale-processing reclaim (5 min), drain()-based
processing behind the SAME liveness poller and boot recovery as the
outbox (`server.js` drives both drains from one poller; ADR-0017 §3's
liveness guarantee extends to scheduled work). No cron, no distributed
scheduler, no second processing architecture.

- Execution is **at-least-once** per scheduled action.
- **Exactly-once business effects** are the handler's idempotency
  contract (the reminder handler's is its notification delivery claim).
- Every due action is **eventually executed or expired while at least
  one healthy API instance runs** — no traffic, no restart required.
- An action **never executes before `runAt`** and **never executes
  after `expiresAt`**.

### 4. Appointment reminders — the first scheduled workflow

`server/scheduler/reminders.js`, two registrations on existing seams:

```
conversation.completed (booked)      [durable outbox event]
  → outbox consumer 'appointment-reminders'
      → scheduler.schedule() one action per configured slot
          → scheduler executes at runAt
              → notificationService.send('appointment-reminder')
                  → Notification Contract renders/brands/delivers
```

Keys follow ADR-0011 with the slot as qualifier:
`appointment-reminder:<sessionId>:<slot>` — the SAME key is the action
key (dedupes scheduling under event redelivery) and the notification
key (exactly-once customer effect under at-least-once execution).
Duplicate reminders are structurally impossible, twice over.

Scheduling-time rules: slots already in the past are skipped (no
backdated reminders); every action expires at the appointment start.
Execution-time rules (the reminder reflects the PRESENT, not the
booking moment): configuration re-checked (disabling later stops
already-scheduled reminders), session must still be booked, caller
looked up through the repository — events and actions never carry
contact details. A delivery `failed` throws for scheduler retry; the
notification claim guarantees retries cannot double-send.

### 5. Configuration — dark by default

The `appointment-reminders` configuration domain (ADR-0016; owner:
scheduler; namespace `scheduler`): `{ enabled, offsets: [{ slot,
minutesBefore }] }`, defaulting to `enabled: false` with 24h and 1h
offsets. Today's production behavior is preserved exactly until a firm
explicitly enables reminders; an additional interval later is one more
offsets entry. The Administration area is registry-generated (ADR-0015
/ ADR-0016) — zero administration code was written.

### 6. Operations Center — zero scheduler-specific architecture

Scheduler telemetry (`scheduler.action_scheduled / action_completed /
action_failed / action_expired`, catalogued and field-allowlisted)
flows through the existing event feed; reminder deliveries appear in
the existing notifications view (its key grammar generalized to
`<type>:<sessionId>[:<qualifier>]`); timelines thread by the same
correlation IDs. Scheduled / due / delivered / failed are all visible
with no new Operations surface.

### 7. Extension model

A future scheduled workflow — follow-ups, surveys, document requests,
retention campaigns, integration syncs — is ONE action definition
published by its owner plus ONE handler registration, with zero
scheduler-core changes (demonstrated in tests with a synthetic
`consultation-follow-up` action). Producers that are not outbox
consumers can schedule directly through the same producer API. Recurring
work reschedules itself from its own handler (a new key per occurrence);
cancellation flows call `cancel(actionKey)` when their workflows arrive.

## Consequences

- GuideHerd can now act at a chosen future time with the platform's
  standard guarantees — the last missing capability class.
- Reminders ship DARK; enabling a firm is one configuration write, and
  the execution-time re-check plus per-slot keys keep every reminder
  truthful and single.
- The outbox and scheduler deliberately share one liveness poller, one
  claim discipline, and one drain contract: reliability infrastructure
  exists exactly once.
- Deliberately out of scope: SMS/voice channels, cron or distributed
  schedulers, calendar synchronization, recurring-schedule syntax —
  each arrives as its own extension on this contract when needed.
