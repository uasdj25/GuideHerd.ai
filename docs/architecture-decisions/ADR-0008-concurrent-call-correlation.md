# ADR-0008: Concurrent Call Correlation

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 9), ADR-0002
(session-based handoffs), ADR-0005 (GuideHerd Connect), ADR-0006
(Operational Store), ADR-0007 (Extension Framework)

## Context

Since Slice 3, connecting a caller to their prepared session has relied on
the *exactly-one-prepared-session* rule: if a firm had exactly one eligible
session, the arriving call was assumed to belong to it; several eligible
sessions were an explicit `409` requiring manual cleanup. That was correct
for a single-receptionist demonstration and is wrong for production: a firm
with two receptionists, or one receptionist with two callers on hold, could
not transfer either of them.

The Operational Store (ADR-0006) removed the state obstacle — sessions are
durable, shared across instances, and pre-provisioned with a
`caller_phone_normalized` column and a tenant-scoped index reserved for this
ticket. What remained was the correlation question itself: **when a call
arrives, which prepared session does it belong to?**

## Decision

### 1. A Correlation Engine owns the question

`server/connect/correlation.js` is the permanent correlation engine.
GuideHerd Core asks one question — *find the matching prepared session* —
and never knows how the match was made (Constitution Principle 4). Provider
code never sees correlation logic; correlation logic never sees provider
payloads (Principle 2, ADR-0007 boundary hygiene).

### 2. Adapters translate dialect into a neutral ConnectIntent

The Conversation Adapter contract (ADR-0005) grows one neutral shape: an
adapter's `translateConnect` returns a **ConnectIntent** of optional,
provider-neutral fields:

- `sessionId` — an explicit GuideHerd session id, when the provider can
  carry one through the call path;
- `callerPhone` — caller ID / ANI exactly as reported (the engine
  normalizes; adapters never do);
- `providerConversationId` — the provider's own conversation reference,
  correlated for provenance but never a key of a GuideHerd object
  (ADR-0007 rule).

No adapter changed behavior: the ElevenLabs adapter still returns an empty
intent, and an empty intent reproduces the pre-correlation behavior exactly.

### 3. Ordered, pluggable signals; the repository does the matching atomically

The engine evaluates an ordered list of **signals**. Each signal extracts
its value from the intent (or reports itself absent) and maps that value to
candidate criteria for one atomic repository call,
`connectEligible(organizationKey, criteria)` — implemented by both the
in-memory reference store and the PostgreSQL store, verified by the shared
contract suite (ADR-0006 pattern). Criteria only ever **narrow** the
eligible set (unexpired `awaiting-transfer`, same organization), and every
criterion is evaluated inside the organization scope: **matching can never
cross tenants**, structurally.

Priority today:

1. **Explicit session id** — authoritative: if present and unmatched, the
   correlation fails rather than falling through to a weaker signal, which
   could connect the wrong caller.
2. **Caller phone** — from provider metadata, normalized to E.164 by a
   deliberately conservative normalizer that returns *no signal* rather
   than a guessed canonical form.
3. **Baseline** — no signal decided: all eligible sessions for the
   organization. Exactly one connects; several is ambiguous; none is 404.
   This is byte-for-byte the pre-correlation behavior, so deployments
   whose providers report nothing regress nothing.

Resolution rules, uniformly: **exactly one candidate connects; more than
one is an explicit `409 ambiguous_prepared_sessions` that redeems nothing —
the engine never picks a session arbitrarily.**

### 4. Future signals extend, never modify

Receptionist workstation, queue id, extension, Teams identity, SIP headers,
authenticated customer identity: each is a new signal object registered at
its priority — plus, where needed, an additive Operational Store column and
criteria key. The engine walk, the existing signals, and the repositories
do not change (Principle 9; ADR-0007 §4). Unknown criteria keys are
rejected loudly by both repositories, so a future signal whose storage
support has not landed fails fast instead of silently matching everything.

### 5. Concurrency guarantees

`connectEligible` inherits ADR-0006's mechanism: candidates are locked
(`SELECT … FOR UPDATE`) in one transaction, so concurrent connects — across
any number of API instances — serialize per session, each session is
redeemed at most once, and connects for *different* callers lock disjoint
rows and proceed in parallel. An ambiguous result rolls back having
redeemed nothing.

### 6. Observability without leakage

`conversation.connected` events now carry `correlation`: the **key** of the
signal that decided (`session-id`, `caller-phone`, `exactly-one-eligible`).
Signal *values* (phone numbers, ids) never appear in events or logs,
per the ADR-0005 event payload rule.

## Consequences

- Multiple simultaneous prepared callers and multiple receptionists are
  supported wherever the provider reports a caller phone or session id;
  where it reports nothing, behavior is unchanged (and multiple prepared
  callers remain an explicit ambiguity rather than a guess).
- `caller_phone_normalized` is populated from creation day forward. Rows
  created before this feature carry `NULL` and simply contribute no phone
  signal; no backfill migration is required (the production table was empty
  at rollout).
- The E.164 normalizer defaults bare national numbers to NANP (`+1`). When
  organizations span dialing plans, the default country code becomes
  per-organization configuration (Principle 5); the call sites are already
  parameterized for it.
- `connectDemo` remains as the criteria-less delegate of `connectEligible`
  while the demo bridge exists; it dies with the bridge, the engine stays.
- The exactly-one-eligible baseline preserves today's operational
  procedure (cancel extras, retry) as the fallback whenever signals cannot
  decide — a deliberate safety-over-convenience default.
