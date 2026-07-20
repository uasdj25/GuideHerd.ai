# ADR-0023: The GuideHerd Communication Adapter Architecture (Telephony)

**Status:** Proposed — spike deliverable (GitLab #37). This is a research
and design record establishing the LONG-TERM telephony integration
strategy; no production implementation ships with it. It becomes Accepted
when the first non-ElevenLabs communication path lands against it.
**Date:** 2026-07-20
**Relates to:** ADR-0005 (GuideHerd Connect — the conversation layer above
telephony), ADR-0007 (Extension Framework), ADR-0011 §7 (provider-side
booking reality), the GuideHerd Constitution (Principles 2, 3, 10 — hide
vendors, own the domain language, outlive technology choices)

## Context

GuideHerd's first (and today only) conversation path is a hosted voice
agent (ElevenLabs) that answers a transferred call, collects/uses caller
context, and reports an outcome. GuideHerd Connect (ADR-0005) already
draws the correct boundary: **GuideHerd owns conversation state**
(prepared-session correlation, lifecycle, outcomes, summary delivery,
provider configuration, conversation events); **external providers own the
call itself** (audio, telephony, media transport); Connect never proxies
audio and never speaks SIP/RTP.

A pilot law firm reaches GuideHerd through whatever telephone system it
already runs. As GuideHerd onboards more firms, "how does a call get from
the firm's phone system to the GuideHerd conversation agent?" becomes the
dominant onboarding variable — and the one most likely to explode cost and
complexity if each firm's telephony is bespoke. This ADR decides the
long-term shape so the second, third, and tenth integration plug into a
decided architecture instead of inventing one per firm.

Inspection facts recorded plainly:
- **No telephony code exists in GuideHerd today.** The connect endpoints
  translate a provider's *webhook dialect* into neutral intents
  (`translateConnect`/`translateOutcome`, `server/connect/adapter.js`);
  the audio path lives entirely inside the voice provider.
- Booking also happens provider-side (ADR-0011 §7); GuideHerd sees
  availability and outcomes, not media.
- The Connect Adapter registry (`providerKey → adapter`) is the existing,
  proven seam for adding a provider without touching Core.

## The question

How should GuideHerd integrate with a wide variety of business telephony
environments while minimizing customer-onboarding complexity and ongoing
operational cost, without committing to any single provider?

## Landscape (research summary)

### Business phone systems firms actually run

| Environment | Reality for a small/mid law firm | Integration surface |
|---|---|---|
| **Hosted VoIP / UCaaS** (RingCentral, 8x8, Zoom Phone, Dialpad, Nextiva) | Most common for firms that modernized; provider hosts everything | Provider APIs + SIP trunk / call-routing rules; some expose call-control APIs |
| **Microsoft Teams Phone** | Common where the firm is M365-centric | Direct Routing (SBC) or Operator Connect; SIP under the hood |
| **On-prem / hosted PBX** (Cisco, Avaya, FreePBX/Asterisk) | Older firms, or those with an IT vendor | SIP trunk to the PBX; dial-plan changes |
| **Analog / basic carrier lines** | The smallest firms | Number porting or forwarding to a GuideHerd-reachable number |
| **"Just a cell/Google Voice"** | Solo practitioners | Call forwarding to a GuideHerd number |

Common denominators: **(a) almost everything is SIP beneath the branding,
and (b) every one of them can forward or route a call to an external
number/SIP endpoint.** That second fact is the cheapest universal on-ramp.

### Connectivity strategies compared

| Strategy | Cost | Complexity | Scalability | Reliability | Onboarding | Long-term maint. | Multi-tenant |
|---|---|---|---|---|---|---|---|
| **CPaaS (Twilio / Telnyx) as the telephony front door** | Per-minute + numbers; predictable | Low — managed SIP/PSTN, programmable voice, SIP-in/out | High (provider-scaled) | High (provider SLAs, redundancy) | Easiest: give the firm a number to forward to, or port in | Low — one integration, provider handles carrier chaos | Strong — numbers/sub-accounts per firm |
| **Direct SIP integration** (GuideHerd runs/terminates SIP) | Lower per-minute, high fixed (SBC, carriers, ops) | High — SBC, NAT/media, codecs, security, 24/7 telecom ops | Medium — you scale it | You own the SLA | Hard — per-firm SIP trunk config | High — telecom is a specialty | Doable but heavy |
| **BYOC (Bring Your Own Carrier)** on top of CPaaS | Firm keeps carrier rates; GuideHerd adds control | Medium | High | High | Medium — needs firm/carrier SIP creds | Medium | Strong |
| **Native per-provider integrations** (Teams, RingCentral APIs, …) | Varies; often free API, real dev cost each | High per provider; N integrations | High | High | Slick for that provider only | High — N codebases track N roadmaps | Per provider |
| **Call-forwarding to a GuideHerd number** (degenerate CPaaS case) | Cheapest | Lowest | High | High | Trivial — set forwarding | Low | Strong |

## Decision

### 1. GuideHerd is telephony-agnostic; a Communication Adapter is the seam

Extend the ADR-0005 Connect model with a **Communication Adapter** layer:
GuideHerd defines a neutral communication contract (a call arrives for firm
X with correlation metadata → connect the prepared conversation; the
conversation ends → report an outcome), and each provider gets a thin
adapter translating its dialect into that contract. This is the SAME shape
as today's Connect adapter registry (`providerKey → adapter`) — the
architecture already exists; this ADR names its telephony generalization
and commits to keeping media out of GuideHerd (Constitution Principle 2;
ADR-0005). GuideHerd never terminates SIP, never proxies RTP, never
becomes a telecom operator.

### 2. Default front door: a CPaaS provider (Twilio or Telnyx), not direct SIP

For the foreseeable roadmap, **route telephony through a CPaaS provider**
rather than building GuideHerd-operated SIP infrastructure. Rationale: it
collapses the entire "every firm's phone system is different" problem into
one managed integration; it gives per-firm numbers/sub-accounts for clean
multi-tenancy; it inherits carrier-grade reliability and 24/7 telecom
operations GuideHerd would otherwise have to staff; and its cost is
predictable per-minute with no large fixed telecom overhead. Direct SIP is
explicitly **rejected as the default** — it trades a modest per-minute
saving for an SBC, carrier relationships, media/NAT engineering, and a
telecom on-call rotation, none of which is GuideHerd's product. Twilio and
Telnyx are interchangeable behind the adapter; the choice between them is a
commercial/operational one (pricing, regions, support), not architectural.

### 3. The universal on-ramp is forward-or-port, tiered by firm sophistication

Onboarding follows a tiered menu, cheapest-first — the firm picks the
lowest tier that meets its needs:

- **Tier 0 — Call forwarding (any phone system on earth):** GuideHerd (via
  CPaaS) issues a number; the firm forwards or routes relevant calls to it.
  Zero telephony integration on the firm side. This is the pilot-grade
  default and covers the long tail.
- **Tier 1 — Number porting:** the firm ports an existing number to the
  CPaaS account for a seamless caller experience.
- **Tier 2 — SIP trunk / BYOC:** firms with a PBX or a carrier they must
  keep connect via SIP into the CPaaS layer (BYOC), preserving their carrier
  rates while GuideHerd keeps the control plane.
- **Tier 3 — Native provider integration** (Teams Direct Routing/Operator
  Connect, RingCentral/8x8 APIs): built **only when a concrete firm needs
  it**, as an additional adapter — never speculatively. N native
  integrations are N maintenance burdens; each must earn its place.

### 4. Provider abstraction strategy (how it plugs into GuideHerd)

A communication adapter is a plain object (mirroring `connect/adapter.js`):
`providerKey`, `translateInbound(dialect) → ConnectIntent` (a call arrived;
correlate it to a prepared conversation), and `translateOutcome(dialect) →
{ sessionId, outcome }`. Validation stays shared and can never be loosened
per provider; caller data is re-read at the boundary, never trusted from a
provider payload; provider selection is per-organization configuration
(the existing `conversation-provider` domain pattern). Adding a provider is
one adapter + one registration + configuration — proven by the ElevenLabs
adapter today. The voice-agent provider (what actually converses) and the
telephony provider (what carries the call) are **separable**: CPaaS can
bridge a call to any voice agent, so GuideHerd is not locked to one vendor
for either layer.

## Implementation roadmap (no code in this ticket)

1. **Now (pilot):** Tier 0 call-forwarding to a single provider number;
   ElevenLabs remains the voice agent. This is the minimum that lets a real
   firm's calls reach GuideHerd. (Depends on GitLab #17 — the live-transfer
   prototype — and on a CPaaS account provisioning, an operator action.)
2. **First multi-firm:** a `communication-provider` configuration domain
   and a CPaaS adapter behind the Connect registry; per-firm numbers.
3. **On demand:** BYOC/SIP-trunk tier for a firm that requires it.
4. **On demand:** the first native integration (likely Teams, given M365
   prevalence) — only when a signed firm needs it.
5. **Continuous:** each new provider is an adapter, never a Core change
   (ADR-0007 §4).

## Expected customer-onboarding experience

- **Smallest firms:** "Forward your intake line to this number." Minutes,
  no IT.
- **Modernized firms:** port a number, or point an existing SIP trunk at
  GuideHerd's CPaaS endpoint — a standard telephony task their provider/IT
  already knows.
- **M365/Teams firms:** eventually a native Teams path; until then, Tier 0
  forwarding works today.
- In every tier the firm configures its OWN phone system to reach a
  GuideHerd-supplied endpoint; GuideHerd never asks for deep access to the
  firm's telecom, and the caller experience is a normal transfer.

## Tradeoffs and risks

- **CPaaS dependency / per-minute cost:** a real operating cost and a
  single commercial dependency. Mitigated by the adapter boundary (Twilio
  ↔ Telnyx swap is config), by BYOC for cost-sensitive firms, and by the
  fact that the alternative (self-run SIP) is more expensive all-in.
- **Latency of an extra hop** (firm → CPaaS → voice agent): acceptable for
  intake; measured during the #17 prototype.
- **Regulatory/number portability** varies by region — a per-firm
  onboarding checklist item, not an architecture problem.
- **Two-vendor coupling** (telephony + voice agent): deliberately kept
  separable so neither locks the other in (Principle 10).
- **Native-integration sprawl:** the standing rule (Tier 3 only on concrete
  demand) is the control; without it, N provider SDKs become N liabilities.

## Consequences

- GuideHerd stays out of the telecom-operator business permanently; media
  never enters the platform (ADR-0005 reaffirmed).
- Onboarding cost scales with a menu, not with bespoke per-firm telephony
  engineering.
- The Connect adapter registry is the single extension point for every
  future communication provider; the roadmap is additive.
- Nothing here changes current behavior: it is a decided destination the
  #17 prototype and the first multi-firm onboarding build toward.
