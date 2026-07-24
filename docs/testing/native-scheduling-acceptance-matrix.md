# GuideHerd v1.0 — Native Scheduling Acceptance & Regression Matrix

**Owner:** GitLab #94 (living checklist; updated as capabilities land).
**Layers:** `neutral` = automated, provider-neutral (reference provider /
disposable PostgreSQL) · `graph` = automated Microsoft Graph contract
tests (mocked tenant) · `live` = live Graph validation (#95, gated by
the Microsoft support case) · `voice` = supervised voice test (#96) ·
`cutover` = production-cutover gate (#96).

Rules for every layer: no destructive testing against production
databases; no writes to non-test mailboxes before cutover; probes never
create bookings; no secrets, raw context tokens, or attendee PII in any
output; **no claim of "no regression" until every row — including all
seven pilot attorneys — is proven.**

Status: ✅ automated and green · 🟡 implemented, pending layer execution
· ⬜ awaiting its capability issue.

## Routing

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Explicit attorney routing | neutral | ✅ | scheduling-targets.test.js, native-availability.test.js |
| Attorney + compatible practice area | neutral | ✅ | scheduling-targets.test.js (matrix + parity) |
| Practice-area-only via single active group | neutral | ✅ | scheduling-targets.test.js, native-booking.test.js |
| Routing-group selection (group calendar vs member pool) | neutral | ✅ | scheduling-targets.test.js |
| Default scheduling target requires explicit permission | neutral | ✅ | scheduling-targets.test.js |
| Unsupported/incomplete routing fails closed, reason for reason | neutral | ✅ | outcome-parity test vs deployed resolver |
| Unknown/inactive catalog keys rejected 400 | neutral | ✅ | offered-slots.test.js (shared validation path) |
| Zero provider calls on unresolved routes | neutral | ✅ | native-availability.test.js (attempt counters) |

## Availability

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Business hours as hard constraint; no hours = no slots | neutral | ✅ | slot-generation.test.js |
| Timezone + DST transitions (spring forward, fall back) | neutral | ✅ | slot-generation.test.js (both directions) |
| Duration policy (appointment type owns duration) | neutral | ✅ | scheduling-targets.test.js |
| Buffers, minimum notice, booking horizon | neutral | ✅ | slot-generation.test.js |
| Provider busy-interval normalization | neutral+graph | ✅ | conformance suite (both providers) |
| Busy classification (busy/oof/tentative block) | graph | ✅ | msgraph-calendar-provider.test.js |
| Deterministic server-side ranking (ADR-0012 authority) | neutral | ✅ | native-availability.test.js |
| At most two caller-facing slots | neutral | ✅ | native-booking.test.js (endpoint) |
| No raw-slot transport through the model; schema unchanged | neutral | ✅ | native-booking.test.js (response key set) |
| Fail closed on any provider read failure (incl. one pool member) | neutral | ✅ | native-availability.test.js |
| getSchedule fidelity on real mailboxes | live | 🟡 | #95 checklist |

## Booking

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Booking-context lifecycle (opaque, hashed, single-use, expiring, tenant-scoped) | neutral | ✅ | booking-context-contract-suite (both stores) |
| Exact offered-timestamp enforcement without consumption | neutral | ✅ | booking.test.js, native-booking.test.js |
| Duplicate/concurrent attempts: single winner, ≤1 provider write | neutral | ✅ | contract suite + native-booking.test.js |
| Slot guard: one live claim/booking per calendar+instant; loser unconsumed | neutral | ✅ | contract suite + native-booking.test.js + PG index test |
| Just-before-create re-check (conflict / unreadable) = definitive rejection | neutral | ✅ | native-booking.test.js |
| booked only after provider confirmation AND durable persistence | neutral | ✅ | booking.test.js (demotion), contract suite |
| Ambiguous outcome -> verification_required; NEVER auto-retried | neutral+graph | ✅ | conformance suite (single-attempt), booking tests |
| Restart recovery (stale in-progress -> verification_required) | neutral | ✅ | contract suite + PG restart persistence test |
| Provider rejection / timeout classification (429 definitive, 5xx ambiguous) | graph | ✅ | msgraph-calendar-provider.test.js |
| Event lands on the ATTRIBUTED calendar with correlation + transactionId | neutral+graph | ✅ | native-booking.test.js, graph request-shape test |
| Live event create/round-trip on the real tenant | live | 🟡 | #95 |

## Lifecycle (cancel / reschedule / reconcile)

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Cancellation with tenant cutoff; refusal reverts; slot released | neutral | ✅ | cancellation.test.js, contract suite |
| Rescheduling: never zero, never two live appointments (all injected failures) | neutral | ✅ | reschedule.test.js |
| Route lock on reschedule (same target; attorney change = new booking) | neutral | ✅ | reschedule.test.js |
| Correlation-mismatch mutation refusal (integrity alarm) | neutral+graph | ✅ | conformance suite, cancellation.test.js |
| verification_required reconciliation from provider evidence (all kinds, both directions) | neutral | ✅ | booking-reconciler.test.js |
| Reconciler: unreachable provider stays queued loudly; legacy skipped | neutral | ✅ | booking-reconciler.test.js |
| Live update/cancel round-trips | live | 🟡 | #95 |

## Notifications

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Exactly-once per lifecycle transition, cross-path key dedupe | neutral | ✅ | booking-lifecycle.test.js |
| NO caller message on verification_required; operator alert instead | neutral | ✅ | booking-lifecycle.js rule + alerting observer |
| ICS attachments (REQUEST/CANCEL/SEQUENCE) delivered as Graph fileAttachment | neutral | ✅ | booking-lifecycle.test.js |
| Provider-invitation double-notify guard (graph-invitations default OFF) | neutral | ✅ | domains.js + booking.js toggle |
| Delivery failure visible, bounded retries, dead-letter | neutral | ✅ | existing delivery-store/outbox suites |
| Live end-to-end email delivery | live | 🟡 | #60 (same support case) |
| Customer reschedule/cancel links (secure, single-purpose, expiring) | neutral | ⬜ | #89 |

## Platform

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Authorization + tenant isolation (scheduling:select/book; cross-tenant opacity) | neutral | ✅ | booking.test.js, contract suite |
| Audit history: every transition exactly one record; failing sink never blocks | neutral | ✅ | contract suite + PG scheduling_audit tests |
| Telemetry hygiene (no tokens, PII, secrets) | neutral | ✅ | booking.test.js, cancellation.test.js, msgraph-auth.test.js |
| Migration compatibility (0009–0011 additive onto live data) | neutral | ✅ | operational.test.js staged-migration tests |
| Provider throttling classification + no-retry | graph | ✅ | provider tests; live patterns 🟡 #95 |
| Admin readiness validation (exists/enabled/bound/ready; coverage unwritable) | neutral | ✅ | readiness.test.js |
| Operations Center visibility + safe resolution | neutral | ⬜ | #92/#93 |

## Transition (coexistence, regression, cutover)

| Row | Layer | Status | Proven by |
|---|---|---|---|
| Per-tenant provider selection; legacy tenants byte-for-byte unchanged | neutral | ✅ | native-booking.test.js (legacy isolation) + full legacy suite green |
| Existing ElevenLabs tool contracts unchanged | neutral | ✅ | response key-set tests; prompt-renderer suite untouched |
| Cal.com regression preservation (full pre-existing matrix) | neutral | ✅ | continuous: 728-test default suite green every commit |
| Rollback: re-select legacy provider via governed config | neutral+cutover | 🟡 | mechanism tested; production rehearsal in #96 |
| Booking outcome reporting + call closing behavior + voice latency | voice | 🟡 | #96 supervised call set (incl. carried-over closing branches) |
| ALL SEVEN pilot attorneys schedulable (named gate; exact Morris scenario) | cutover | 🟡 | #96 |
| Live Graph end-to-end (consent, discovery, free/busy, lifecycle, throttling) | live | 🟡 | #95 (blocked by the Microsoft support case) |
| Cal.com decommission preconditions | cutover | 🟡 | #97 |

## Current suite totals (updated per commit)

Default profile: **728 tests / 727 pass / 1 known PG-gated skip.**
PostgreSQL-gated (disposable PG 16): **818/818** as of commit 276fd84;
migrations 0001–0011 fresh + idempotent + staged-additive-with-data.
