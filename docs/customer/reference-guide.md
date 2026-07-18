# Reference Guide

Lookup tables, limits, and terms. For when you know what you're after.

---

## Timings and limits

| Thing | Value | Notes |
|---|---|---|
| Transfer window | **10 minutes** | How long a prepared session waits |
| Sign-in session | **8 hours** | Absolute — not extended by activity |
| Concurrent prepared sessions per firm | **20** | Adjustable at deployment |
| Recent handoffs shown | **25** | No date filter, no export |
| Recent notifications shown | **25** | Same |
| Default reminder times | **24 hours and 1 hour** before | Only if reminders are enabled |

---

## Console statuses

| Status | Meaning | Receptionist does |
|---|---|---|
| Ready for caller information | Waiting for the form | Fill it in |
| Preparing the scheduling assistant… | Setting up | Wait |
| Ready to transfer | Session prepared | Transfer now |
| Connected | Caller reached the assistant | Nothing — done |
| Appointment booked | Confirmed | Read details back |
| Scheduling could not be completed | Booking failed | Take details by hand |
| Human assistance required | Needs a person | Take the call back |
| Session cancelled | Ended deliberately | Prepare a new one |
| Session expired | Window ran out | Prepare a new one |

---

## Notification delivery statuses

| Status | Meaning |
|---|---|
| **sent** | Delivered. Final — never sends twice. |
| **failed** | Retries exhausted. **Nobody was alerted.** |
| **not-configured** | Email isn't set up on this deployment |
| **pending** | In progress |

---

## Roles

| Role | Can | Cannot |
|---|---|---|
| **Receptionist** | Use the Reception Console | Operations, Administration |
| **Operator** | View the Operations Center | Change anything |
| **Administrator** | Change configuration | Operations Center, Reception Console |

**Roles do not nest.** Someone needing more than one job needs more than one
role.

---

## What can be changed, and by whom

| Setting | Who |
|---|---|
| Firm name, display name, timezone | You |
| Attorney order within a group | You |
| Appointment confirmation on/off | You |
| Sender name, accent color, footer text | You |
| Scheduling preferences | You — but **not yet applied to bookings** |
| Practice areas, attorneys, routing | Request |
| Consultation types | Request |
| Offices, business hours | Request — and **not yet enforced** |
| Reminders and their timings | Request |
| Logo, office contact block | Request |
| Console sign-in | Request |
| Users and roles | Request — deployment change + restart |
| Summary recipient mailbox | Request |
| Sending email address | Request |

---

## Notifications that exist

| Notification | To | Default |
|---|---|---|
| Consultation summary | **Your firm** | **On** |
| Appointment confirmation | The caller | **Off** |
| Appointment reminder | The caller | **Off** |
| Cancellation | — | **Does not exist** |
| Reschedule | — | **Does not exist** |

**Email only.** No SMS.

---

## What survives a restart

| Data | Survives? |
|---|---|
| Firm configuration and change history | **Yes** |
| Booked appointments | **Yes** — in your calendar system |
| Active prepared sessions | No |
| Notification delivery records | No |
| Pending reminders | No |
| Operations Center history | No |
| Sign-in sessions | No |

Durable storage exists but isn't enabled by default.

---

## Not available today

Things people reasonably expect, that GuideHerd does not have:

- SMS or text messaging of any kind
- Cancellation or reschedule workflows, and their notifications
- Single sign-on (Microsoft, Google, Okta)
- Self-service password reset, invitations, multi-factor authentication
- A user management screen
- Minimum notice, appointment buffers, per-type durations
- Enforcement of business hours
- Application of scheduling preferences to real bookings
- Automatic backups
- Automatic deletion of old caller data
- Undo for configuration changes
- Alerting when something fails
- Reporting, charts, data export
- Custom domains or theming beyond email
- Data-export-on-request or erasure tooling

Some are planned; none can be relied on today.

---

## Glossary

**Attorney** — someone who takes appointments.

**Consultation type** — the kind of appointment (new matter, follow-up, existing
client). Firm-wide.

**Correlation ID** — an identifier starting `gh-` that ties one call's records
together. **The most useful thing to quote when contacting support.**

**Handoff** — passing a caller from your receptionist to the scheduling
assistant.

**Operator** — someone who can view the Operations Center but change nothing.

**Practice area** — what a matter is about; what the receptionist selects.

**Prepared session** — a session created but not yet transferred. Lasts 10
minutes.

**Routing / scheduling group** — how a practice area maps to a set of attorneys.

**Session ID** — the identifier for one prepared session. Useful for support.

**Summary** — the email your firm receives after each call, recording what
happened.

---

## Where things live

| I want to… | Go to |
|---|---|
| Prepare and transfer a caller | Reception Console |
| See what happened | Operations Center |
| Change a setting | Administration |
| Find a specific call | Operations Center → Search |
| See who changed what | Administration → recent changes |
| Get a caller's details for a past call | The consultation summary email |

Caller names, emails, and phone numbers are deliberately **not** shown in the
Operations Center. The summary email is where those live.
