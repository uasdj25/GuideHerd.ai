# Runbook: Scheduling-Policy Cutover — point the assistant at the slot-selection seam

**Applies to:** the GuideHerd Scheduling Policy Engine (ADR-0012) and the
ElevenLabs scheduling assistant (GuideHerd Connect, ADR-0005).
**Issue:** #66
**Status:** **NOT YET CUT OVER.** The GuideHerd-side seam is complete, tested,
and live in production; the ElevenLabs assistant does **not** yet call it, so a
real caller is still offered raw provider availability. This runbook is the
controlled, post-demo cutover — it is deliberately unperformed until after the
Martinson & Beason demonstration.

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
below and must not be performed until after the demo.

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

## Cutover procedure (post-demo, in order — each step reversible)

1. **Confirm the demo is finished** and a maintenance window is agreed.
2. *(Recommended)* Provision the dedicated assistant credential in
   `GUIDEHERD_STATIC_IDENTITIES` (Railway, production) and redeploy. Verify the
   seam still returns 200 for the new credential and 401/403 without it.
3. **Configure the ElevenLabs agent tool** (in the ElevenLabs console — external):
   add/point the availability tool so that, after fetching provider availability,
   it calls the seam with the credential and offers back only the returned slots.
   Update the agent instructions to *use the returned slots verbatim* and to stop
   encoding any ranking/hours logic in the prompt.
4. **Remove the "stored only" markings** for scheduling policy and business hours
   in `docs/customer/configuration-guide.md` (they now shape offered slots).
5. **Flip ADR-0012** from *Proposed* to *Accepted* (the seam is now in the caller
   path) and record the cutover date.
6. **Live verification** (below).

---

## Verification

### Demo-safe (already runnable now, no production touch)

```
cd server && node --experimental-sqlite --test scheduling/selection.test.js
```

Proves the seam ranks, constrains by hours, enforces authorization, matches the
contract, and degrades gracefully — end to end over HTTP with mocked availability.

### Live (post-cutover only — requires the ElevenLabs agent; do NOT run before cutover)

- Place a test call; set the firm policy to "mornings preferred" (Administration
  screen); confirm the assistant offers morning slots first for identical
  availability.
- Configure business hours to exclude a window that the calendar has; confirm the
  assistant never offers a slot in that window.
- Confirm determinism: the same availability + same policy yields the same order.
- Confirm graceful degradation: with no policy, offers are chronological.

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
- **Latency** — the seam does no external I/O (synchronous Configuration Store
  reads), so it adds negligible latency; there is no timeout surface to tune.

---

## Notes

- ADR-0018 (Scheduler Contract) governs background reminders/scheduled actions —
  it is **not** part of this availability→offer path. The relevant ADRs are
  ADR-0012 (policy seam), ADR-0005 (Connect), and ADR-0011 §7 (provider-side
  booking).
- This runbook and the seam are organization-agnostic; the pilot firm
  (`martinson-beason`) is used only in examples.
