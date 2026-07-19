# ADR-0002: Use Session-Based Handoffs

**Status:** Accepted — implemented and governing on `main`.

## Status

Accepted

## Context

In the initial scheduling product, a receptionist qualifies a caller and then
transfers them to the Scheduling Assistant to book a consultation. Something has
to carry the context across that transfer — who the caller is, which firm and
attorney, what they need — so the caller does not repeat themselves and the
assistant does not start blind. Passing that context ad hoc through vendor calls
would scatter the truth of the interaction across systems we do not control.

## Decision

Every handoff is anchored by a GuideHerd **Scheduling Session**.

- Every receptionist-to-assistant transfer begins by creating a Scheduling
  Session.
- The session carries the caller and scheduling context needed to book.
- Sessions are short-lived; they exist for the duration of one interaction.
- Handoff tokens are single-use and expire.
- Because the session holds context, the caller does not repeat information they
  already gave the receptionist.
- The voice provider receives only the minimum context required to run the
  conversation — never the full record.

The session is the source of truth for the interaction. Its current conceptual
shape:

| Field | Meaning |
|-------|---------|
| `sessionId` | Unique identifier for the interaction |
| `firmId` | The firm this session belongs to |
| `caller` | Caller details captured at qualification |
| `scheduling` | Requested consultation context (type, attorney, preferences) |
| `handoff` | Single-use handoff token and its state |
| `status` | Lifecycle state of the session |
| `createdAt` | When the session was created |
| `expiresAt` | When the session (and its handoff) expire |

These fields are conceptual. This ADR does not specify storage technology,
serialization, or transport — those are implementation choices behind the
Session Service.

## Consequences

- The flow is consistently **Receptionist → GuideHerd → Lex**: the receptionist
  opens a session, GuideHerd owns it, and Lex orchestrates the conversation from
  it.
- Vendors receive scoped, minimal context, which limits data exposure.
- There is a session lifecycle to manage: creation, expiry, and single-use token
  validation.
- Interaction history has one authoritative home rather than being reconstructed
  from vendor logs.

## Alternatives Considered

- **Stateless handoff — pass all context to the vendor.** Simpler to wire up,
  but leaks data, gives the vendor the record, and makes callers repeat
  themselves if anything drops.
- **Long-lived sessions.** Unnecessary for a single booking interaction and adds
  data-retention and security surface with no product benefit.
