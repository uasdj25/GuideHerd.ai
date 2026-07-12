# ADR-0001: Customer Experience Owns the Architecture

## Status

Accepted

## Context

GuideHerd is built on top of several third-party providers — voice, scheduling,
calendar, email, and AI models. Left unchecked, architectures like this tend to
organize themselves around whatever vendor is easiest to call. Vendor object
shapes leak into APIs, vendor terms leak into the UI, and swapping a provider
becomes a customer-visible event. That makes GuideHerd a thin wrapper over other
people's products instead of a product in its own right.

## Decision

The customer experience defines the architecture, not the vendors.

- GuideHerd is the customer-facing product. The firm interacts with GuideHerd.
- Customer workflows define service boundaries. We model the receptionist's day
  and the caller's booking, then draw services around those flows.
- Third-party systems are hidden behind GuideHerd services and reached only
  through adapters.
- Public APIs and UI use GuideHerd domain language (Appointment, Consultation
  Type, Firm), never vendor terminology.
- Replacing a vendor must not change what a customer sees or the contracts they
  depend on.

## Consequences

- New work starts from a customer capability, not from a vendor's API surface.
- Contracts and terminology stay stable even as providers change underneath.
- There is more of our own domain code — services, models, and adapters — rather
  than direct vendor calls.
- Reviewers should reject customer-facing code that exposes vendor concepts.

## Alternatives Considered

- **Integrate directly against each vendor.** Faster to first demo, but couples
  the product to vendor APIs and makes provider changes customer-visible.
- **Thin wrapper per vendor with no shared domain.** Still leaks vendor models
  upward and provides no common GuideHerd language for APIs and UI.
