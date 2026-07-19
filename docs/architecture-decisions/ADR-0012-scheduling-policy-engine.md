# ADR-0012: The GuideHerd Scheduling Policy Engine

**Status:** Accepted — the live selection seam shipped with #66:
`POST /api/v1/scheduling/slot-selection` (service-identity authorized,
`scheduling:select`) runs provider-supplied availability through the
business-hours constraint (hard — `scheduling/hours.js`) and this engine
(ranking), so the engine governs every offer that flows through GuideHerd.
The one remaining activation step is operator-side: pointing the scheduling
assistant's calendar tool at the seam, verified by test calls.
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 3, 4, 5, 10), ADR-0004
(configuration store), ADR-0007 (Extension Framework — Scheduling is a
named contract family), ADR-0011 §7 (the calendar-provider reality and
the API-side booking direction)

## Context

Scheduling decisions were provider decisions: the assistant's external
calendar tool returns whatever availability the calendar provider chooses
to expose, in the provider's order, shaped by the provider's own
configuration. GuideHerd — which owns the workflow and models the
business (attorneys, practice areas, consultation types, firm
preferences) — had no say in *which* available time gets offered.

Inspection fact recorded plainly: **no Scheduling extension exists
in-platform today.** Availability never flows through GuideHerd — booking
happens inside the assistant's own calendar tool (see ADR-0011 §7). This
ADR therefore establishes the permanent policy boundary and its engine
now, so the first Scheduling extension plugs into a decided architecture
instead of inventing one.

## Decision

### 1. Providers answer "what is available?"; GuideHerd answers "what should we offer?"

The Scheduling Policy Engine (`server/scheduling/engine.js`) executes
AFTER a provider returns availability and BEFORE anything reaches a
caller. Providers remain completely unaware of policy — they translate
their dialect into the neutral slot contract (startsAt, durationMinutes,
attorneyId, consultationTypeId, location) and nothing else. Unknown slot
fields are dropped at the boundary; malformed slots are dropped and
counted, never fatal. Provider ranking is never GuideHerd ranking.

### 2. Policies are organization configuration, never code

The `scheduling/policy` setting (ADR-0004 pattern) holds a firm's
preferences — the first set: preferred attorneys (ordered), preferred
days of week, morning/afternoon, preferred consultation duration,
preferred consultation types. Validation is fail-safe field-by-field: a
malformed field degrades one preference and is reported; it never breaks
scheduling. No setting means no policy — and no policy means today's
behavior exactly (chronological availability, scores all zero). The
setting is the future Administration Portal's editing surface; no UI is
built here.

### 3. Selection: guarded filtering, then additive ranking, fully deterministic

FILTER removes only structural incompatibility (a slot typed for a
different consultation than requested), and every filter is guarded — if
it would empty the set it relaxes and says so. RANK sums small,
independent scoring dimensions: the caller's own requested attorney
outranks the organization's preferred attorneys, which outrank day/time/
duration/type preferences; policies compose additively and never compete.
Ties break by earliest start, then attorney key, then input order — a
total ordering, so identical inputs always produce identical output.
Day and time-of-day are evaluated in the organization's timezone.

Fallback is graceful by construction: an unavailable preferred or
requested attorney can lower nothing to zero candidates — the result
flags `requestedAttorneyUnavailable` so the caller can be told honestly,
and every other attorney's availability still returns. Scheduling never
fails because a preference cannot be met.

### 4. Extensibility: one scorer per future policy

Attorney priority tiers, overflow attorneys, practice-area routing,
office location, language, vacation calendars, working hours,
consultation length rules, virtual/in-person, existing-client priority,
VIP routing — each is a new optional policy field plus one pure scorer
(or one guarded filter) in the engine's dimension list. The engine's
control flow never changes (ADR-0007 §4). Deliberately NOT built now.

### 5. Activation path

The engine ships fully built and tested with no live call path — there
is nothing to call it yet. It activates when the first Scheduling
extension lands (the ADR-0011 §7 direction: booking moves API-side
behind a GuideHerd contract): that extension returns neutral slots, Core
calls `selectSlots()` with the organization's resolved policy, and the
caller is offered GuideHerd's ranking. The assistant-side booking flow
is untouched until then — current behavior is the default in the
strongest possible sense.

## Consequences

- Which times a caller hears is a GuideHerd decision expressed in firm
  configuration — portable across any scheduling provider, unchanged by
  provider swaps (Principle 10).
- Firms get business-language preferences ("mornings, Clay first,
  30 minutes") rather than provider settings (Principle 3).
- The first Scheduling extension's job shrinks to translation: dialect →
  neutral slots in, ranked candidates out.
- A deliberate limitation: policy applies at presentation time; it
  cannot create availability (vacation calendars and working hours, when
  they arrive, are filters over provider truth, not calendar writes).


## Addendum (#66): the shipped seam and the business-hours constraint

`scheduling/selection.js` composes, in order: sanitation (malformed slots
dropped and counted) → **business hours** (`scheduling/hours.js`, a HARD
constraint honoring the three-hours model — the whole appointment must fit
one window on one local day, judged in the applicable location's timezone;
slot-named location wins, a sole hours-bearing location covers unlabeled
slots, several locations leave a slot visibly `unscoped` rather than
guessed) → this engine's guarded filters and additive deterministic
ranking. Only the firm's own hard hours rule can produce an empty offer,
and it does so loudly (`scheduling.slots_exhausted`, warn). Telemetry:
`scheduling.slots_selected` with received/offered/removed counts — never
slot content. Input is bounded (200 slots) and strictly validated.
