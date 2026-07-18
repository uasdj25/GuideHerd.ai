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

**Find out whether your deployment reloads its setup from a file at startup.**

If it does, that file is the source of truth, and **anything you change in the
Administration screen is silently reverted at the next restart.** The two modes
are mutually exclusive.

Ask your GuideHerd contact which mode you're in. Get this wrong and you'll spend
an afternoon configuring, then watch it vanish without warning.

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
| Practice areas | **Request** | Visible in Administration but not editable |
| Attorneys | **Request** | Visible but not editable |
| Which attorneys serve which practice area | **Request** | Routing groups |
| Attorney order within a group | **Self-service** | |
| Consultation types | **Request** | No screen at all |

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
| Business hours | **Stored only** | Recorded, but enforced by nothing |
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

---

## Notifications

| Setting | Status | Default |
|---|---|---|
| Consultation summary to your firm | **Request** | **On** |
| Appointment confirmation to the caller | **Self-service** | **Off** |
| Appointment reminders | **Request** | **Off** |
| Reminder timings | **Request** | 24 hours and 1 hour before |
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
| Logo | **Request** | Must be an HTTPS address |
| Office contact block | **Request** | Phone, email, address |

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
| Users and their roles | **Request** | Deployment change + restart |
| Session length | **Request** | 8 hours, absolute |
| Single sign-on (Microsoft / Google / Okta) | **Not available** | |

Session length is **absolute, not sliding** — a receptionist is signed out 8
hours after signing in regardless of activity, and signs back in.

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
5. **The file-reload question** — settings reverting on their own is almost
   always this
