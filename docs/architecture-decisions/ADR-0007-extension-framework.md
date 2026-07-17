# ADR-0007: The GuideHerd Extension Framework

**Status:** Draft — architectural direction only; no implementation is
authorized by this ADR
**Date:** 2026-07-18
**Relates to:** GuideHerd Constitution (Principles 2, 4, 8, 9, 10),
ADR-0003 (hide vendor dependencies), ADR-0005 (GuideHerd Connect),
ADR-0006 (Operational Store)

## Context

GuideHerd already practices provider abstraction in one vertical slice:
GuideHerd Connect's Conversation Adapter (ADR-0005) separates the
ElevenLabs/Twilio dialect from the conversation workflow, and the mailer
boundary hides Microsoft Graph. Each integration so far has invented its
own seam. As the platform grows — more channels, more calendars, more
customer systems — ad-hoc seams would drift apart in shape, testing
approach, configuration, and failure behavior.

The Constitution commits GuideHerd to a platform model: Core owns business
workflow; external systems are replaceable implementations behind
contracts. This ADR names the general pattern those commitments imply, so
future integration ADRs extend one framework instead of re-deriving the
idea.

## Decision

### 1. Three-layer vocabulary: Core → Extension → Provider

- **GuideHerd Core** owns business workflow, business objects, and
  orchestration. Core depends only on **extension contracts** — never on
  a provider, a provider SDK, a provider payload shape, or a provider
  name.
- An **extension** is a replaceable implementation of one or more
  extension contracts. Extensions translate between GuideHerd's canonical
  contracts and a specific provider's dialect. All provider-specific
  knowledge — payload shapes, quirks, authentication mechanics, error
  vocabularies — lives inside extensions.
- A **provider** is the external system an extension uses: Twilio,
  Outlook, Teams, SIP, Cal.com, Filevine, OpenAI, Anthropic, ElevenLabs,
  and their successors. Providers are invisible to GuideHerd Core.
  Customer-facing business workflows use GuideHerd domain language rather
  than provider terminology (Constitution Principle 10). Authorized
  customer administrators may view or select configured integrations
  where operationally necessary, but provider payloads, credentials, and
  implementation mechanics remain behind the extension boundary.

An extension may implement several contracts (one system can supply
calendar and email); a contract may have many extensions (voice via
different telephony stacks). The relationship is many-to-many by design.

### 2. Contracts are GuideHerd-owned and provider-neutral

Extension contracts are defined by GuideHerd in GuideHerd domain language,
versioned with the platform, and shaped by what the business workflow
needs — never by mirroring a provider's API. Canonical validation lives
with the contract, not the extension: an extension can translate dialect
but can never loosen a contract's rules (the pattern ADR-0005's outcome
handling already established).

### 3. GuideHerd owns workflow; extensions provide capabilities

Business logic — what happens when a caller is prepared, connected,
booked, escalated; what a Consultation Summary contains; when follow-up
occurs — remains in Core. Extensions provide capabilities Core invokes
(place this on a calendar, deliver this message, look up this case) and
report facts Core interprets. An extension never makes a business
decision.

### 4. Extending the platform never modifies the platform

New integrations are added by implementing existing contracts and
registering the extension — following the adapter registry pattern
GuideHerd Connect already uses. Adding a provider must not require
touching Core routing, workflow, validation, or existing extensions.
When a genuinely new *capability* (not provider) appears, the contract
family grows by a new contract — an additive platform change with its own
ADR.

### 5. The contract families

The framework applies uniformly to current and future integration
surfaces:

- **Communication** — conversations over voice, SMS, chat, Teams, email,
  and future channels. Channels are communication extensions feeding the
  same Guide (Constitution Principle 8): adding a channel adds an
  extension, never a change to Core or to the Guide's business role.
- **Scheduling** and **Calendar** — booking workflow versus calendar
  systems of record.
- **Email** and **Notifications** — delivery of GuideHerd-owned
  artifacts (the Graph mailer boundary is the proto-example).
- **Knowledge** — customer knowledge sources a Guide may consult.
- **Case Management** — customer systems of record (e.g. legal case
  systems).
- **Payments** and **Identity** — when those capabilities arrive.

Each family earns its concrete contract through its own ADR when first
implemented; this ADR fixes only the shape they share.

### 6. Cross-cutting rules every extension inherits

- **Configuration, not code:** which extension serves an organization is
  Configuration Store data (the `connect/conversation-provider` setting is
  the existing example). Secrets are never configuration — they stay in
  the deployment environment.
- **Explicit failure:** a configured-but-unavailable extension fails
  loudly with a controlled error; there is never a silent substitute
  (the pattern set by `conversation_provider_unavailable` and the
  Operational Store's fail-fast boot).
- **State stays in GuideHerd:** anything that must survive an extension
  or provider failure lives in the Operational Store, keyed by GuideHerd
  identifiers. Provider-side identifiers may be *correlated* (stored as
  references) but never become primary keys of business objects.
- **Boundary hygiene:** raw provider payloads, credentials, transcripts,
  and recordings do not cross the extension boundary into Core, storage,
  or logs. Extensions are tested against the shared contract behavior
  (the contract-suite pattern ADR-0006 established), with providers
  mocked — never called — in automated tests.

## Consequences

- Future integration ADRs get a common vocabulary (contract, extension,
  provider) and a checklist (registry, configuration, failure mode,
  state, hygiene, contract tests) instead of inventing seams.
- Existing seams — the Conversation Adapter, the mailer boundary — are
  retroactively recognizable as extensions of this framework; they
  migrate to any formalized shape gradually, not in a rewrite.
- Multi-channel Guides become an extension-count problem, not an
  architecture problem: voice today; SMS, chat, Teams, email later —
  same Guide, same Core, more communication extensions.
- The cost is discipline: the framework forbids the expedient shortcut
  of letting a provider SDK or payload shape leak into Core, even when
  that would ship a feature faster. ADR-0006's dependency-exception
  process (documented, deliberate, pinned) is the template for when an
  extension needs a provider SDK at all.

## Explicitly out of scope

No implementation is authorized by this ADR: no extension-loading
mechanism, no new directories, no interface files, no refactoring of
existing adapters. Those arrive through subsequent ADRs and tickets, each
aligned with — and citing — this direction.
