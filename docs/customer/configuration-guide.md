# Configuration Guide

Every setting, what it does, and — just as important — whether you can actually
change it yourself.

---

## How to read this guide

GuideHerd's settings fall into three groups, and knowing which group something
is in saves a lot of time:

| Marker | Meaning |
|---|---|
| **Self-service** | Change it yourself in Administration. Takes effect immediately. |
| **Request** | Real and changeable, but no screen exists. Ask your GuideHerd contact. |
| **Stored only** | Can be saved, but **nothing uses it yet.** Changing it has no effect today. |

The **Stored only** group is the one to watch. Those settings look like they
work — they save, they validate, they persist — but nothing acts on them.

---

## Before you change anything

**Check the banner at the top of the Administration screen.** It tells you
whether changes made here stick:

- **Live** (green) — this screen is the source of truth. Changes you save
  survive restarts and updates.
- **Seed-managed** (yellow) — this deployment reloads its setup from a file at
  every restart, and changes saved here **will be overwritten**. Contact
  GuideHerd support before editing anything.
- **Just imported** (yellow) — the setup was loaded from a file when the
  system last started. That's normal for a brand-new deployment, but if it
  wasn't just set up, confirm with GuideHerd support before editing.

If the banner isn't green, don't spend an afternoon configuring — ask first.

---

## Firm identity

| Setting | Status | Notes |
|---|---|---|
| Firm name | **Self-service** | Used in notifications |
| Display name | **Self-service** | How the firm is presented |
| Timezone | **Self-service** | See the warning below |

> **Timezone is the highest-risk setting in GuideHerd.** It's the reference for
> appointment times. Set it wrong and everything still *looks* correct — the
> failure only appears when a caller arrives at the wrong hour.
>
> Check it before your first real call, and check it again if your firm moves or
> opens a second location.

---

## Practice areas, attorneys, and routing

| Setting | Status | Notes |
|---|---|---|
| Practice areas | **Self-service** | Create, rename, deactivate |
| Attorneys | **Self-service** | Create, rename, deactivate |
| Which attorneys serve which practice area | **Self-service** | Routing groups: create, assign, membership & order |
| Attorney order within a group | **Self-service** | |
| Consultation types | **Self-service** | Create, rename, deactivate |

**Practice areas** are what your receptionist chooses from. Make them match how
your firm actually talks about its work — the receptionist has to map a real
caller onto this list in seconds, mid-call.

**Attorneys** reach practice areas through scheduling groups. If a practice area
has no attorneys, the receptionist sees **"No Attorneys Configured"**. Sessions
can still be prepared, but it's a sign the setup is incomplete — fix it.

**Consultation types** are firm-wide, not per practice area. Your receptionist
must choose one on every call; there's no "unspecified" fallback. Keep the list
short — every extra option is a decision on a live call.

---

## Scheduling

| Setting | Status | Notes |
|---|---|---|
| Preferred attorneys | **Stored only** | |
| Preferred days of week | **Stored only** | |
| Morning / afternoon preference | **Stored only** | |
| Preferred appointment length | **Stored only** | |
| Business hours | **Self-service** to edit — but **stored only**: enforced by nothing yet |
| Minimum notice before an appointment | **Not available** | Doesn't exist |
| Buffer between appointments | **Not available** | Doesn't exist |
| Per-type appointment lengths | **Not available** | Doesn't exist |

> **Read this before setting scheduling preferences.**
>
> These settings save correctly and are validated. **Nothing applies them to
> real bookings yet.** Availability comes from your calendar system, and the
> part of GuideHerd that would rank it against your preferences isn't connected.
>
> Setting them is harmless and they'll take effect when that lands. But if you
> set "mornings preferred" and afternoons get booked, nothing is broken — it
> isn't wired up.
>
> **Business hours are the same.** Recording them does not prevent an
> appointment outside them. If that matters to your firm, raise it as a
> requirement rather than assuming the setting handles it.

### Three kinds of "hours" — keep them separate

People collapse these into one idea and then get surprised. They are three
independent things, and a firm can set them differently on purpose:

| Concept | Means | Answers |
|---|---|---|
| **Guide availability** | When the AI Guide may answer calls | "Can someone reach the Guide right now?" |
| **Staffed reception hours** | When human receptionists are working | "Is a person on the phones?" |
| **Appointment-booking availability** | When attorneys permit appointments | "Can this caller be booked into that slot?" |

**These do not have to match, and usually shouldn't.**

A Guide that answers calls around the clock does **not** mean appointments can
be booked around the clock. A caller reaching the Guide at 11pm should still
only be offered slots your attorneys actually allow — booking availability is
governed by attorney calendars and your firm's booking rules, not by whether
anyone answered.

Conversely, staffed reception hours are about your people, not the system. A
firm may have receptionists 9–5 while the Guide covers evenings, or no Guide at
all and receptionists only.

When you're setting something, be clear which of the three you mean. "We're open
9 to 5" can mean any of them, and the right place to configure it differs.

---

## Notifications

| Setting | Status | Default |
|---|---|---|
| Consultation summary to your firm | **Request** | **On** |
| Appointment confirmation to the caller | **Self-service** | **Off** |
| Appointment reminders | **Self-service** | **Off** |
| Reminder timings | **Self-service** | 24 hours and 1 hour before |
| Cancellation / reschedule notifications | **Not available** | Doesn't exist |

**Email only.** No SMS or text messaging anywhere in GuideHerd.

**Consultation summary** goes to a single firm mailbox set at deployment — not
per-user, and not changeable in Administration.

**Appointment confirmation is off deliberately.** Your calendar system already
emails the caller its own invitation. Turning this on as well means **every
caller gets two emails.** Only enable it after confirming your calendar system
isn't already doing it.

**Reminders**, when enabled:

- Only apply to appointments booked **after** you turn them on — no backfill
- Stop immediately if you turn them off, even for reminders already scheduled
- Are skipped rather than sent late if their time has already passed
- Only reach callers who gave an email address

---

## Branding

| Setting | Status | Notes |
|---|---|---|
| Sender name | **Self-service** | Appears *in* emails |
| Accent color | **Self-service** | A single colored line |
| Footer text | **Self-service** | Closing line |
| Logo | **Self-service** | Must be an HTTPS address |
| Office contact block | **Self-service** | Phone, email, address |

Two limits worth stating plainly:

- **The sender name does not change the From address.** Emails send from the
  mailbox your deployment uses. Your firm's name appears in the message; the
  address is GuideHerd's unless a firm-specific mailbox was set up at
  deployment. Own-domain email is a deployment request.
- **Branding affects emails only.** No theming of the Reception Console, no
  custom colors on screens, no custom domain.

The consultation summary to your firm stays GuideHerd-branded regardless.

---

## Access and sign-in

| Setting | Status | Default |
|---|---|---|
| Reception Console sign-in | **Request** | **Off** |
| Users and their roles | **Self-service** | Users card on the Administration screen — immediate, incl. deactivation. The initial administrator account is set up with GuideHerd |
| Session length | **Request** | 12 hours, absolute |
| Single sign-on (Microsoft / Google / Okta) | **Not available** | |

Session length is **absolute, not sliding** — a receptionist is signed out 12
hours after signing *in*, regardless of activity, and signs back in.

12 hours is chosen so a normal shift never hits the boundary mid-call: someone
may sign in before their shift, and shifts plus lunch, overtime, and handoff
coverage routinely exceed eight hours. If your firm runs longer shifts than
that, it can be raised per deployment.

Turning on Console sign-in is a planned change: every receptionist must be
provisioned and verified first, or they can't work the moment it's on.

---

## How changes behave

**Immediately live.** No restart, no redeploy — the next call uses the new
setting.

**All-or-nothing.** A change with an error is rejected whole. Nothing partially
valid is ever saved.

**Protected against collisions.** If someone else changed something since you
loaded the page, your save is refused with a message to reload and retry. Reload,
re-apply, save. This prevents silent overwrites.

**Recorded.** What changed, who changed it, and the before-and-after are kept and
visible in Administration.

**Not reversible.** History shows what changed but cannot undo it. To reverse
something, change it back by hand — so **note the old value before changing
anything significant.**

---

## What to check first

If something isn't behaving, check in this order:

1. **Timezone** — wrong times, callers arriving at the wrong hour
2. **Practice areas and attorneys** — "No Attorneys Configured", or receptionists
   picking options that don't fit
3. **Consultation types** — the list doesn't match how the firm works
4. **Notification settings** — nothing arriving, or callers getting two emails
5. **The banner at the top of the Administration screen** — settings reverting
   on their own almost always means it isn't green
