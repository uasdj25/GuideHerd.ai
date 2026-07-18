# GuideHerd Architecture

Required reading for contributors. This document is short on purpose. Read it
before adding services, APIs, or vendor integrations.

## Vision

**GuideHerd is the platform.**

Third-party services are implementation details. Customers interact with
GuideHerd, never directly with the underlying vendors that power a capability.
A firm books a consultation through GuideHerd; it does not know or care which
voice provider, scheduling provider, or model provider sits behind the wall.

## Platform Model

Every request flows through the same conceptual layers:

```
Customer
    ↓
GuideHerd Experience
    ↓
GuideHerd Business Services
    ↓
Vendor Implementations
```

Each layer only knows the one directly below it. The customer never reaches
past the Experience layer; business logic never reaches past a business
service; only adapters inside a business service touch a vendor.

**GuideHerd Experience** — the surfaces customers and staff actually use:
- Customer Portal
- GuideHerd Console
- Administration Portal
- Scheduling Assistant

**GuideHerd Business Services** — the platform's capabilities, in GuideHerd terms:
- Session Service
- Scheduling Service
- Customer Configuration Service
- Notification Service
- Workflow Service (Lex)
- Reporting Service *(future)*

**Vendor Implementations** — replaceable providers behind the services:
- Voice provider
- Scheduling provider
- Calendar provider
- Email provider
- AI model provider
- Storage provider

> Vendors are named nowhere in this architecture as first-class concepts. The
> current implementations happen to be a hosted voice widget, a hosted
> scheduling backend, an Outlook calendar, and a set of AI models — all of them
> replaceable examples, not architectural commitments.

## Engineering Principles

### 1. GuideHerd owns the customer experience
The product is GuideHerd. Screens, language, and flows are ours. A vendor's UI
or terminology should never surface to a customer.

### 2. Every external dependency hides behind a GuideHerd service
No customer-facing code calls a vendor directly. A vendor is reached only
through the business service that owns that capability, via an adapter.

### 3. GuideHerd speaks GuideHerd domain language
APIs, models, and UI use business terms (Appointment, Consultation Type,
Firm) — not vendor object names. See [Domain Language](#domain-language).

### 4. Build products, not integrations
We ship capabilities customers understand, not point-to-point plumbing between
two vendors. An integration is an implementation detail of a capability.

### 5. Every recurring manual configuration step is a future Administration Portal feature
If we configure the same thing by hand for each firm, that step is a portal
feature waiting to be built. Track it as such.

### 6. Receptionists are the primary daily users of the initial scheduling product
The first product is used, all day, by receptionists. Design for their
workflow first; other surfaces come later.

### 7. Lex is an internal service
Lex is GuideHerd's internal Workflow Service. It is never the customer-facing
product and is never named to customers.

### 8. Sessions are the source of truth for customer interactions
A customer interaction is a Session. Context, handoff, and status live on the
session — not scattered across vendor calls.

### 9. Solve one customer problem exceptionally well before expanding
Scheduling for law firms comes first and comes complete. Breadth follows depth.

### 10. Architecture should outlive technology choices
Vendors, APIs, and model providers will change. The customer experience,
business logic, and public contracts should not have to change with them.

## Domain Language

GuideHerd APIs and customer-facing documentation use these terms:

| Use | Meaning |
|-----|---------|
| Scheduling Assistant | The GuideHerd surface that books consultations |
| Consultation Type | A kind of appointment a firm offers |
| Appointment | A booked consultation |
| Firm | A customer organization (e.g. a law firm) |
| Attorney | A person a caller can be booked with |
| Receptionist | The staff member who handles inbound callers |
| Caller | A prospective client contacting the firm |
| Scheduling Session | One handoff-to-booking interaction (source of truth) |
| Handoff | The receptionist-to-assistant transfer |
| Notification | An outbound confirmation or reminder |

Vendor terms (widget IDs, provider event names, calendar object types) must not
leak into public APIs or customer-facing documentation.

## Core Services

Service boundaries below are **logical** boundaries — they define ownership and
contracts, not a requirement to deploy separate microservices. Today they may
live in one codebase; the boundaries let them separate later without a rewrite.

- **Session Service** — creates and owns Scheduling Sessions, the record of a
  customer interaction. Issues and validates handoff context.
- **Scheduling Service** — availability, consultation types, and appointments.
  Hides the scheduling and calendar providers behind one GuideHerd contract.
- **Customer Configuration Service** — per-firm settings: attorneys,
  consultation types, hours, notification rules. The Administration Portal is
  its front end.
- **Notification Service** — outbound confirmations and reminders in GuideHerd's
  branding, independent of the email or messaging provider used.
- **Workflow Service (Lex)** — GuideHerd's internal orchestration of a
  scheduling conversation. Coordinates the assistant, session, and scheduling
  logic behind the scenes.

## Architecture Decision Records

- [ADR-0001: Customer Experience Owns the Architecture](docs/architecture-decisions/ADR-0001-customer-experience-owns-the-architecture.md)
- [ADR-0002: Use Session-Based Handoffs](docs/architecture-decisions/ADR-0002-session-based-handoffs.md)
- [ADR-0003: Hide Vendor Dependencies Behind GuideHerd Services](docs/architecture-decisions/ADR-0003-hide-vendor-dependencies-behind-guideherd-services.md)
- [ADR-0004: Embedded Configuration Store](docs/architecture-decisions/ADR-0004-embedded-configuration-store.md)
- [ADR-0005: GuideHerd Connect — the Conversation Layer Above Telephony](docs/architecture-decisions/ADR-0005-guideherd-connect-conversation-layer.md)
- [ADR-0006: Operational Store — Durable Handoff State in PostgreSQL](docs/architecture-decisions/ADR-0006-operational-store-postgresql.md)
- [ADR-0007: The GuideHerd Extension Framework](docs/architecture-decisions/ADR-0007-extension-framework.md)
- [ADR-0008: Concurrent Call Correlation](docs/architecture-decisions/ADR-0008-concurrent-call-correlation.md)
- [ADR-0009: The GuideHerd Identity Contract](docs/architecture-decisions/ADR-0009-identity-contract.md)
- [ADR-0010: GuideHerd Authorization](docs/architecture-decisions/ADR-0010-authorization.md)
- [ADR-0011: The GuideHerd Notification Contract](docs/architecture-decisions/ADR-0011-notification-contract.md)
- [ADR-0012: The GuideHerd Scheduling Policy Engine](docs/architecture-decisions/ADR-0012-scheduling-policy-engine.md)
- [ADR-0013: GuideHerd User Sessions](docs/architecture-decisions/ADR-0013-user-sessions.md)
- [ADR-0014: The GuideHerd Operations Center](docs/architecture-decisions/ADR-0014-operations-center.md)
- [ADR-0015: The GuideHerd Administration Framework](docs/architecture-decisions/ADR-0015-administration-framework.md)

See also [Vision](docs/Vision.md) and [Roadmap](docs/Roadmap.md).

---

**Every external dependency should hide behind a GuideHerd service.**

This lets GuideHerd adopt new technologies without changing the customer
experience, business logic, or public APIs.

Technology evolves. GuideHerd should not.
