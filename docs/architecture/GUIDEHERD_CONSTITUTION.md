# GuideHerd Constitution

> **Status: living document.** This is not an ADR. It is the architectural
> constitution of the GuideHerd platform: the long-term principles that
> future architecture and ADR decisions align with unless intentionally and
> explicitly superseded. When an ADR deviates from a principle here, the ADR
> must say so and say why. Amendments to this document are deliberate,
> reviewed changes — not drift.

## Mission

GuideHerd provides AI-powered digital employees ("Guides") that integrate
into customer businesses without requiring customers to replace working
infrastructure.

GuideHerd is a platform. Guides are applications built on that platform.

---

## Principle 1 — Integrate, never rip-and-replace

GuideHerd never requires a customer to replace working infrastructure.

GuideHerd integrates with customer investments whenever practical.

---

## Principle 2 — Core depends on contracts, not providers

GuideHerd Core never depends on a specific provider.

Core business logic depends only on provider contracts.

Providers are replaceable implementations.

---

## Principle 3 — Model the business, not the technology

GuideHerd models customer business capabilities rather than implementation
technologies.

Customers configure business concepts rather than infrastructure.

Examples include:

- Guides
- Attorneys
- Practice Areas
- Business Rules
- Office Hours
- Scheduling Policies

---

## Principle 4 — GuideHerd owns the workflow

GuideHerd owns business workflow.

Providers supply capabilities.

Business logic remains inside GuideHerd.

---

## Principle 5 — Behavior lives in configuration

Customer behavior belongs in configuration whenever practical.

Changing customer workflow should rarely require code changes.

---

## Principle 6 — Operational state survives failure

Operational state survives process failure.

Operational data belongs in the Operational Store.

Configuration belongs in the Configuration Store.

---

## Principle 7 — A Guide is a role, not an implementation

A Guide is a business role, not a technology implementation.

Internally GuideHerd refers to these as AI Employees.

Customers see them as Guides.

A Guide remains independent of:

- AI model
- Prompt
- Voice provider
- Telephony provider
- Communication channel

---

## Principle 8 — Conversations, not communication technologies

GuideHerd manages conversations rather than communication technologies.

Voice, SMS, chat, Teams, email, and future channels become communication
channels feeding the same Guide.

---

## Principle 9 — Extend through provider contracts

GuideHerd Core is extended through provider contracts.

New providers extend the platform rather than modifying platform logic.

Examples include:

- Communication providers
- Scheduling providers
- Calendar providers
- Email providers
- Knowledge providers
- Case Management providers
- Payment providers
- Notification providers

---

## Principle 10 — Stable business objects, evolving implementations

Business objects remain stable while implementations evolve.

Stable platform concepts:

- Organizations
- Guides
- Capabilities
- Business Rules
- Conversations
- Operational State
- Configuration
- Provider Contracts

Twilio, Outlook, Teams, SIP, Cal.com, Filevine, OpenAI, Anthropic,
ElevenLabs, and future providers are replaceable implementations.
