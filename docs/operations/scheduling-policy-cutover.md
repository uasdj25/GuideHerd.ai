# Runbook: Scheduling-Policy Cutover — point the assistant at the slot-selection seam

**Applies to:** the GuideHerd Scheduling Policy Engine (ADR-0012) and the
ElevenLabs scheduling assistant (GuideHerd Connect, ADR-0005).
**Issue:** #66
**Status:** **NOT YET CUT OVER.** The GuideHerd-side seam is complete, tested,
and live in production; the ElevenLabs assistant does **not** yet call it, so a
real caller is still offered raw provider availability. This runbook is the
**controlled cutover** — performed and validated in a scheduled window **before**
the Martinson & Beason demonstration, with the rollback rehearsed and kept ready
throughout.

---

## What is already done (no further repository work required)

- **The seam:** `POST /api/v1/scheduling/slot-selection` (`server/handoff/app.js`)
  → `selectOfferedSlots` (`server/scheduling/selection.js`): sanitize → **hard
  business-hours constraint** (`hours.js`) → **deterministic policy ranking**
  (`engine.js`). Service-identity authorized (`scheduling-assistant` role →
  `scheduling:select`).
- **Configuration:** the `scheduling-policy` domain and per-office **business
  hours** already feed the engine from the Configuration Store (ADR-0016).
- **Contract:** `docs/api/slot-selection.md` (neutral slot request/response).
- **Tests:** `server/scheduling/selection.test.js` proves — at the HTTP seam —
  that a saved policy reorders real offered slots, outside-hours slots are never
  offered, authentication and permission-level authorization are enforced, the
  response matches the documented contract, malformed payloads are handled, and
  every policy dimension ranks deterministically.

**There is no remaining GuideHerd code change.** The only remaining work is
*external*: pointing the assistant's calendar tool at the seam. That step is
below and is performed in a controlled validation window before the demo, with
rollback ready.

---

## The integration (what the assistant must do)

Booking is provider-side (ADR-0011 §7); GuideHerd shapes the **offer**, not the
booking. In the caller flow:

1. The assistant's calendar tool fetches provider availability (unchanged).
2. The assistant **POSTs those slots** to `POST /api/v1/scheduling/slot-selection`
   in the neutral slot contract, with the service credential (below).
3. GuideHerd returns the **ranked, business-hours-constrained** slots to offer.
4. The assistant offers **only** the returned slots, in the returned order, and
   books the caller's choice provider-side.

**GuideHerd owns the ranking.** The assistant/prompt must NOT re-encode business
hours or preference ordering — it presents what the seam returns. This keeps
policy in one place (the engine) and changeable by configuration, not by editing
prompts.

### Service credential

The seam requires a bearer token whose identity holds `scheduling:select` (the
`scheduling-assistant` role, org-scoped). Today `DEMO_BRIDGE_SECRET` doubles as
that identity. **Recommended at cutover:** provision a *dedicated* assistant
credential via `GUIDEHERD_STATIC_IDENTITIES` (a separate Railway variable), e.g.

```json
[{ "token": "<high-entropy secret>", "subject": "scheduling-assistant",
   "type": "service", "organizationKey": "martinson-beason",
   "roles": ["scheduling-assistant"] }]
```

so the assistant's credential is not coupled to the demo bridge secret. This is
a Railway configuration step (see the deployment reference), not a code change.

---

## Customer-facing latency and failure behavior (v1)

The cutover adds one **synchronous ElevenLabs → GuideHerd** HTTPS call into the
caller-facing flow. Because a caller hears the delay, latency and failure
behavior are first-class.

### Four distinct latency components

Keep these separate when measuring — only the third is *added* by this cutover:

| Component | What it is | Added by cutover? |
|---|---|---|
| **Local scheduling-engine time** | `selectOfferedSlots()` — sanitize + hard business hours + deterministic ranking (pure computation + Configuration Store reads) | measured locally |
| **GuideHerd HTTP route processing** | the seam's parse → auth → config reads → engine → serialize, inside the API process | measured locally |
| **ElevenLabs → GuideHerd tool-call / network latency** | the HTTPS round trip: TLS, public internet, Railway ingress — the *dominant* added cost | **yes** — measure in the voice test |
| **Calendar-provider lookup latency** | the assistant's existing availability fetch | **no** — pre-existing; excluded from the budget below |

### Send the full candidate list in ONE batched request

The assistant MUST send the **entire** candidate-slot list to
`/api/v1/scheduling/slot-selection` in a **single** request. Do **not** call the
seam per slot:

- Ranking is *relative across the whole set* — per-slot calls cannot rank.
- Per-slot calls multiply the network round trip by the slot count — the single
  largest latency risk.
- The contract accepts up to 200 slots / 16 KB (≈ 100 typical slots) per request;
  a real week of availability fits in one call.

### Conversational latency acceptance criteria

- **Baseline (before cutover):** measure scheduling latency as it is today
  (calendar lookup + the assistant forming its offer, no GuideHerd call). Record
  **p50 and p95**.
- **After cutover:** measure the **incremental** latency of the GuideHerd
  selection call. Record **p50 and p95**.
- **Target: < 250 ms added latency at p95** for the GuideHerd selection call,
  **excluding** the existing calendar-provider lookup.
- Verify through **one controlled voice call** that **no unnatural spoken pause**
  is introduced.

### Local timing (measured) — and why it is not the whole picture

`server/scripts/bench-slot-selection.js` measures the two GuideHerd-local
components over a ~100-slot week (loopback, **not** real network):

```
engine (selectOfferedSlots): p50 ≈ 14 ms   p95 ≈ 18 ms
http route (in-process):     p50 ≈ 15 ms   p95 ≈ 20–27 ms
```

(Illustrative; machine- and run-dependent — rerun locally.) GuideHerd's own
processing is on the order of ~15–30 ms at p95 — comfortably inside the 250 ms
budget, leaving essentially all of it for the network round trip. **The
network component is not measurable in the repository** and MUST be measured
during the controlled voice test (the pre-demo validation run); these numbers only bound the
route/engine portion.

### Synchronous-path safety

- **Bounded ElevenLabs tool timeout.** Recommended starting value: **750 ms**
  (well above the ~15–30 ms local processing plus a realistic network RTT, and
  below a caller-perceptible stall).
- **No synchronous retry** during the caller-facing flow — a retry doubles the
  delay the caller hears. (The seam's own internal retry is for its own
  dependencies, not for the assistant's tool call.)
- **A timeout or failure must never strand the caller in silence** — the
  assistant proceeds per the failure policy below.

### v1 failure policy

Two clearly-separated cases:

**Transient failure** — the GuideHerd call **times out** (past the 750 ms bound)
or returns a **5xx / network error**:

- The assistant **MAY fall back to the provider candidate slots** — offer raw
  availability, exactly the pre-cutover behavior. The caller still gets times.
- Emit **sanitized telemetry** recording that **policy selection was bypassed**
  (reason + counts only — never caller data). Where the request reached GuideHerd
  but failed, its existing `provider.*` / request-failure telemetry applies; where
  it never arrived (timeout / network), the **assistant/Connect side must record
  the bypass** so it is not invisible.
- **Do not expose an internal error to the caller** — the caller hears normal
  options, not an apology or an error.
- **Repeated failures must be visible through operational monitoring** — the
  Operations Center capability view (ADR-0014) plus alerting (#68 internal, #23
  external). A steady bypass rate is an operational signal, not a silent norm.

**Deterministic error** — a **400 (malformed)** or **401 / 403 (unauthorized)**:

- These indicate a **configuration or integration defect**, not a transient
  runtime condition. They must **NOT silently fall back as though successful.**
  Surface them loudly (fail the cutover verification; alert), fix the integration,
  and re-verify. **Only transient failures are eligible for the graceful fallback.**

---

## Cutover procedure (controlled pre-demo, in order — each step reversible)

1. **Agree a validation window before the demo** and confirm the rollback is ready.
2. *(Recommended)* Provision the dedicated assistant credential in
   `GUIDEHERD_STATIC_IDENTITIES` (Railway, production) and redeploy. Verify the
   seam still returns 200 for the new credential and 401/403 without it.
3. **Configure the ElevenLabs agent tool** (in the ElevenLabs console — external):
   add/point the availability tool so that, after fetching provider availability,
   it calls the seam **once, with the full candidate list**, using the credential,
   and offers back only the returned slots. Set a **bounded tool timeout (start at
   750 ms)** and **no synchronous retry**; on a timeout or transient failure the
   assistant falls back to raw provider availability per the failure policy above.
   Update the agent instructions to *use the returned slots verbatim* and to stop
   encoding any ranking/hours logic in the prompt.
4. **Remove the "stored only" markings** for scheduling policy and business hours
   in `docs/customer/configuration-guide.md` (they now shape offered slots).
5. **Flip ADR-0012** from *Proposed* to *Accepted* (the seam is now in the caller
   path) and record the cutover date.
6. **Live verification** (below).

---

## Verification

### Demo-safe (runnable now, no production touch)

```
cd server && node --experimental-sqlite --test scheduling/selection.test.js   # seam behavior
cd server && node --experimental-sqlite scripts/bench-slot-selection.js       # local engine/route timing
```

The test suite proves the seam ranks, constrains by hours, enforces
authentication and permission-level authorization, matches the documented
contract, handles malformed payloads, and degrades gracefully — end to end over
HTTP with mocked availability. The benchmark reports **GuideHerd-local timing
only** (see "Local timing" above); real network latency is a voice-test
measurement, not a repository one.

### Live voice tests (the pre-demo validation run — require the ElevenLabs agent; run only after the tool is wired)

1. **Baseline voice test** — with the policy call *disabled* (or immediately
   pre-cutover): place a call through booking, record the scheduling timing
   (p50/p95) and confirm normal behavior.
2. **Policy-enabled voice test** — with the seam wired and "mornings preferred"
   set: place a call, record the timing, and confirm morning slots are offered
   first and no slot outside business hours is offered.
3. **Compare timing** — the *added* latency (policy-enabled minus baseline,
   excluding the calendar lookup) is **< 250 ms at p95**, with no unnatural pause.
4. **Only returned slots are spoken** — when the policy call succeeds, the
   assistant offers exactly the seam's returned slots, in order — nothing else.
5. **Graceful continuity when unavailable** — deliberately make the policy call
   fail (e.g. point the tool at a wrong URL or force a timeout): the caller still
   hears slots (raw availability), there is **no silence and no spoken error**,
   and the **bypass telemetry** is recorded.
6. **Rollback restores the previous configuration** — revert the ElevenLabs agent
   tool/instructions; confirm the assistant returns to offering raw provider
   availability (pre-cutover behavior) with **no GuideHerd deploy**.

---

## Success criteria

- A real caller's offered slots **observably reflect** the saved policy and
  business hours (mornings-first; nothing outside hours).
- Ordering is deterministic for identical availability + policy.
- No ranking or hours logic lives in the ElevenLabs prompt — the assistant
  presents what the seam returns.
- The Configuration Guide no longer says "stored only"; ADR-0012 is Accepted.

## Rollback

Cutover is fully reversible with **no GuideHerd deploy**:

- Revert the ElevenLabs agent tool/instructions to the pre-cutover version (the
  assistant offers raw provider availability again — exactly today's behavior).
- Optionally remove the dedicated assistant credential from
  `GUIDEHERD_STATIC_IDENTITIES` and redeploy.

The GuideHerd seam is safe to leave live either way — it does nothing until the
assistant calls it.

## Risks

- **Prompt duplication of policy** — if ranking/hours are re-encoded in the
  ElevenLabs prompt, the two can diverge. Mitigation: the assistant must present
  the seam's output verbatim.
- **Credential coupling** — reusing `DEMO_BRIDGE_SECRET` ties the assistant to
  demo infrastructure; provision a dedicated identity (above).
- **Empty offers** — if a firm's hours exclude all availability, the seam returns
  an honest empty offer and emits `scheduling.slots_exhausted` (warn); the
  assistant should have a "no times available" path. This is configuration, not a
  defect.
- **Latency** — GuideHerd-local processing is ~15–30 ms at p95 (measured;
  `scripts/bench-slot-selection.js`). The dominant added latency is the
  ElevenLabs→GuideHerd network round trip, bounded by the tool timeout (start
  750 ms) and measured in the voice test. See "Customer-facing latency and
  failure behavior" for the batching rule, acceptance criteria, and failure policy.

---

## Consolidated availability cutover (SUPERSEDES the two-tool wiring above)

The failed 2026-07-22 voice test (2–3 minutes of caller-facing latency;
`select_offered_slots` never received; policy silently bypassed) retired
the two-tool integration this runbook originally described. Availability
now flows through ONE small GuideHerd tool — `get_offered_slots`
(`POST /api/v1/scheduling/offered-slots`, `docs/api/offered-slots.md`);
the language model never transports slot batches, and there is no
raw-slot fallback: every failure escalates without offering times.

### ElevenLabs cutover checklist (execute in a validation window)

1. Create the `get_offered_slots` webhook tool
   (`docs/demo/elevenlabs-get-offered-slots-tool.json`; the auth
   connection ID is environment-specific).
2. Attach `get_offered_slots` to the demo agent.
3. Remove or detach the Cal.com **Get Available Slots** tool from the agent.
4. Remove or detach **select_offered_slots** from the agent.
5. Verify **Create Booking** remains attached.
6. Verify **get_prepared_caller** remains attached.
7. Verify **report_scheduling_outcome** remains attached.
8. Verify **End conversation** remains attached.
9. Inspect the agent's EFFECTIVE tool list after saving — exactly the
   five tools above, nothing more.
10. Run a test conversation proving no direct Cal.com availability tool
    can be called (ask for times; confirm the transcript shows only
    `get_offered_slots` supplying them).

### Booking-consistency gate (MANDATORY before the demo)

The booking tool's configured Cal.com event type MUST equal the
`scheduling/calcom-availability` `eventTypeId` (and any per-attorney
mapping must match on both sides). Availability from one calendar must
never be booked into another. Verify in the console against the Railway
configuration before any voice test.

### Deployment configuration checklist (status as of 2026-07-23)

| Item | Where | Status |
|---|---|---|
| Organization key (`martinson-beason`) | production SQLite | present and verified (serving traffic) |
| Cal.com event type ID (`6287134`, Initial Consultation) | `scheduling/calcom-availability` | **known and repository-configured** (operator-established 2026-07-23), subject to final booking-tool PARITY verification in the console; production SQLite **not yet updated** — requires deployment/import |
| Attorney→event mappings | same setting | none defined by design — single shared event type for the pilot |
| Default duration (30 minutes) | same setting | known and repository-configured; production import pending |
| `CALCOM_API_KEY` | Railway variable | **secret requiring manual entry — missing** |
| Provider timeout | `GUIDEHERD_AVAILABILITY_TIMEOUT_MS` (optional) | default 1200 ms, clamped ≤ 1500 ms; unset is correct |
| Agent auth connection | ElevenLabs workspace | present (used by `get_prepared_caller` — verified working 2026-07-22) |
| Tenant timezone (`America/Chicago`) | organization record | known and repository-configured; production organization predates this work — expected present, verify at import |
| Default consultation type (`initial-consultation`) | `scheduling/default-consultation-type` | known and repository-configured; production import pending |
| Rendered prompt artifact | `docs/demo/martinson-beason-scheduling-prompt.md` | repository version exists — paste at cutover |
| Attached agent tool list | ElevenLabs console | old two-tool wiring live — replace per the consolidated-tool checklist above |

## Notes

- ADR-0018 (Scheduler Contract) governs background reminders/scheduled actions —
  it is **not** part of this availability→offer path. The relevant ADRs are
  ADR-0012 (policy seam), ADR-0005 (Connect), and ADR-0011 §7 (provider-side
  booking).
- This runbook and the seam are organization-agnostic; the pilot firm
  (`martinson-beason`) is used only in examples.
