# ADR-0005: GuideHerd Connect — the Conversation Layer Above Telephony

**Status:** Accepted — implemented and governing on `main`.
**Date:** 2026-07-16
**Relates to:** ADR-0002 (session-based handoffs), ADR-0003 (hide vendor
dependencies behind GuideHerd services), ADR-0004 (configuration store)

## Context

The Martinson & Beason demonstration now runs end-to-end on a native
telephony integration: a public phone number rings straight into the
external voice-assistant runtime, the assistant retrieves the prepared
caller from GuideHerd, books through its calendar tool, reports the outcome
back, and GuideHerd produces the Consultation Summary. That integration
works and is intentionally staying in place.

It also concentrates a risk: the only seam between GuideHerd and the voice
provider was two demo routes whose request shapes quietly absorbed
provider-specific dialect (a webhook UI that requires a nonempty JSON body;
a webhook editor that cannot nest objects, forcing a flat outcome format).
Left alone, every future provider would grow its own routes and its own
dialect handling, and "which provider serves this firm" would live nowhere.

Customers will not all arrive through the same provider. Law firms run
Teams, RingCentral, Cisco, and plain SIP trunks; other verticals will bring
Telnyx, Zoom Phone, or direct Twilio. GuideHerd's value — context that
follows the work — must not be re-implemented per provider.

## Decision

1. **GuideHerd owns conversation state; providers own the call.**
   GuideHerd Connect (`server/connect/`) is the provider-neutral
   conversation layer: prepared-session correlation, conversation
   lifecycle, outcome recording, Consultation Summary delivery,
   provider configuration, and conversation events. Audio, telephony,
   SIP/RTP, and media transport remain entirely with the external provider.
   GuideHerd Connect never proxies audio and never runs a telephony server.
   Conversation state is business state — who was prepared, what was
   confirmed, what was booked, what needs follow-up — and that state must
   survive a provider swap. The call itself is transport.

2. **A Conversation Adapter per provider.** An adapter
   (`server/connect/adapter.js`) translates one provider's dialect into
   GuideHerd's neutral contracts: `translateConnect` (the provider asks for
   the prepared caller) and `translateOutcome` (the provider reports the
   result). Dialect tolerances live inside the adapter; canonical
   validation is shared and identical for every provider — an adapter can
   never loosen the contract. Adapters are registered in a registry and
   resolved per firm.

3. **The first adapter wraps today's integration without changing it.**
   `ElevenLabsAdapter` names the two dialect facts already in production
   (ignored connect body; flat outcome format with `reason` aliasing
   `schedulingSummary`) and delegates to the existing, heavily-tested
   validation. The demo routes now call the adapter and the conversation
   service; their external contracts are byte-for-byte unchanged, which the
   pre-existing test suite proves.

4. **Provider selection is configuration.** The active provider for an
   organization is the Configuration Store setting
   `connect/conversation-provider` (per ADR-0004, new families start as
   namespaced settings), defaulting to today's provider when unset so an
   unconfigured deployment keeps working. A firm explicitly configured for
   an unregistered provider fails loudly (`503
   conversation_provider_unavailable`) — GuideHerd never silently
   substitutes providers. Secrets never live in this setting; credentials
   stay in the process environment.

5. **Conversation events are the extensibility seam.** The conversation
   service emits `conversation.connected` and `conversation.completed`
   with identifiers and transition facts only — never tokens, credentials,
   provider payloads, or caller contact details. Nothing subscribes in v1;
   the point is that the lifecycle is now observable at a neutral boundary,
   where the future Operational Store, live console updates, and follow-up
   workflows attach without touching provider code.

6. **Conversation state stays on the session in v1 — intentionally and
   transitionally.** GuideHerd Connect v1 owns the conversation boundary,
   orchestration, provider abstraction, configuration, and lifecycle
   events. It **intentionally delegates conversation state transitions to
   the existing Handoff state machine**
   (awaiting-transfer → connected → booked/failed/escalated, plus
   cancelled/expired). This avoids introducing a second source of truth
   while preserving the existing atomicity (synchronous check-and-mark),
   concurrency guarantees, idempotency, and session lifecycle behavior
   exactly as tested. **This delegation is a deliberate architectural
   decision, not technical debt**: when the future Operational Store is
   introduced, conversation state ownership migrates from Handoff into
   GuideHerd Connect — conversations gain their own persisted records and
   a richer state machine — **without changing provider integrations or
   public contracts**, because adapters and routes already talk only to
   the Conversation Service. At that point the handoff session returns to
   what ADR-0002 designed it as: a short-lived context-transfer artifact.

## Architecture

```
        Telephony / Voice Provider
   (e.g. phone number → assistant runtime)
          owns audio · telephony · media
                     │
                     ▼
           Conversation Adapter          ◀── Configuration Store
        (per-provider dialect only)          connect/conversation-provider
                     │                       selects the adapter per firm
                     ▼
           Conversation Service ────────▶ Conversation Events
            (GuideHerd Connect)             conversation.connected
                     │                      conversation.completed
                     ▼
           Handoff State Machine
   (session transitions, atomicity, idempotency —
        the v1 source of truth for state)
```

Everything above the Conversation Adapter belongs to the provider;
everything below it belongs to GuideHerd. The adapter line is where dialect
ends and contract begins.

## How future providers plug in

However a call arrives — Teams, RingCentral, Cisco, Telnyx, a SIP trunk,
Zoom Phone, or Twilio under a different assistant runtime — the assistant
side of that call needs the same two exchanges: *get the prepared caller*
and *report the outcome*. A new provider means:

1. Implement a Conversation Adapter translating that runtime's request
   dialect into the neutral contracts (and, later, its lifecycle signals
   into conversation events).
2. Register it in the adapter registry.
3. Point the firm's `connect/conversation-provider` setting at it.

No route redesign, no changes to sessions, summaries, or the console, and
no media handling — if a proposed integration needs GuideHerd to touch
audio, it belongs in the provider, not in an adapter.

## Consequences

- Provider dialect is quarantined: adding or replacing a voice provider
  cannot ripple into business workflow, and the outcome contract cannot be
  loosened per provider.
- The demo bridge routes remain temporary (per Slice 3 documentation), but
  the conversation layer they now delegate to is permanent — when trusted
  telephony delivery replaces the bridge, the routes die and Connect stays.
- Conversation events add a stable subscription point for the Operational
  Store and live console features, decoupled from providers.
- One more resolution step (config → provider key → adapter) runs per
  demo-bridge request; it is an in-process SQLite point read with a
  fail-safe default and no measurable cost at demo volume.
- The `server/connect/` module imports from `server/handoff/` (session
  service, outcome delivery). That direction is deliberate: Connect
  orchestrates sessions; sessions know nothing about Connect or providers.
