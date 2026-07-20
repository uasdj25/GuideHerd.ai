# Administrator Guide

This guide is for whoever runs GuideHerd for a firm — setting it up, keeping it
right, and sorting out problems.

It's honest about what GuideHerd does well and what it doesn't do yet, because
you can't plan around a limitation nobody told you about.

---

## Your firm in GuideHerd

Everything belongs to your firm: practice areas, attorneys, appointment types,
settings, history. Your firm's information is kept separate from every other
firm's, and that separation is enforced by the system rather than by
configuration you could get wrong.

Your firm has a **timezone**, and it matters more than anything else on this
page. It's the reference point for appointment times. Get it wrong and every
booking is wrong in a way that looks perfectly fine on screen — until a caller
turns up at the wrong hour.

---

## The three screens

| Screen | Who | What |
|---|---|---|
| **Reception Console** | Receptionists | Prepare callers, transfer them |
| **Operations Center** | Operators, administrators | See what's happened. Read-only. |
| **Administration** | Administrators | Change your firm's setup |

![The Administration Center](images/administration-center.png)

---

## Roles

Four roles exist. Three are for people.

| Role | Can |
|---|---|
| **Receptionist** | Use the Reception Console |
| **Operator** | View the Operations Center. Nothing else. |
| **Administrator** | Change configuration |

**Roles do not nest.** This surprises people, so it's worth stating flatly:

- An **administrator cannot see the Operations Center.**
- An **operator cannot change configuration.**
- Neither can use the Reception Console.

Someone who needs to configure the firm *and* watch operations *and* cover the
phones needs all three roles assigned. This is deliberate — each role grants
exactly what its job requires and nothing more — but it does mean you should
think about who needs what before provisioning anyone.

---

## User management

**You manage your firm's users yourself, in the Administration screen** —
the Users card under Access. No deployment changes, no restarts, no waiting.

What you can do there:

- **Add a person.** Choose their user ID, name, and roles. GuideHerd issues
  their sign-in credential and shows it **exactly once** — copy it immediately
  and hand it over securely (in person or through a channel you trust). It is
  never shown again and nobody, including GuideHerd, can look it up later.
- **Change roles.** Takes effect immediately, even on sessions that are
  already signed in — no re-login needed.
- **Deactivate someone.** Takes effect immediately: their current session ends
  on their very next action, and their credential stops working. Offboarding
  is instant. (Reactivating restores the same credential.)
- **Issue a new credential** for someone who lost theirs. The old credential
  stops working immediately; the new one is shown once, like at creation.

Guardrails to know about:

- **You cannot deactivate your own account**, and the last active
  administrator cannot be deactivated or stripped of the administrator role —
  the system will not let a firm lock itself out.
- **Every user change is recorded** in the change history with who made it
  and what changed. Credentials never appear there.

There is no self-service password reset, no invitations, no self-registration,
and no multi-factor authentication. Sign-in uses an issued credential rather
than a password — if someone loses theirs, an administrator issues a new one.

Single sign-on through Microsoft, Google, or Okta is **not available today.**
The platform is built to accept it later without disruption, but nothing is
implemented — don't plan a rollout around it.

---

## Sign-in for the Reception Console

By default the Reception Console **does not require a sign-in.** Anyone who can
reach the page can use it. For a firm where the console lives on a front-desk
machine on the office network, that is often a reasonable posture.

Sign-in can be switched on. When it is:

- Receptionists sign in with an issued credential
- Their name appears at the top right, with a **Sign out** link
- Sessions last **12 hours absolute** — measured from signing in, not extended
  by activity. Chosen so a normal shift never hits the boundary mid-call, since
  someone may sign in before their shift and shifts plus lunch and overtime
  routinely exceed eight hours
- On the standard production setup, a restart no longer signs people out

**Switching this on is a planned change, not a setting you flip.** Every
receptionist must be provisioned and individually verified first, because the
moment it's on, an unprovisioned receptionist cannot work. Ask your GuideHerd
contact to follow the activation runbook, which includes rehearsing the switch
back.

---

## Setting your firm up

### Practice areas, attorneys, and routing

**Practice areas** are what a caller's matter is about — what your receptionist
picks from. They should match how your firm actually describes its work, because
your receptionist has to map a real caller onto this list in seconds.

**Attorneys** are who takes appointments. Each is reachable through one or more
scheduling groups, and each practice area routes to a group. That's how choosing
"Family Law" produces the right list of names.

Practice areas, attorneys, routing groups, and attorney **ordering** are all
editable on the Administration screen — create, rename, activate/deactivate,
and reassign routing yourself; changes take effect immediately.

### Consultation types

The kinds of appointment your firm offers — new matter, follow-up, existing
client. Firm-wide, not per practice area. Your receptionist must pick one on
every call; there's no "unspecified" option. Editable on the Administration
screen like the rest of the catalog.

### Offices and business hours

Offices and their opening hours are editable on the Administration screen.
**Business hours are designed to be a hard rule on offered times** — the
selection capability that enforces them (the whole appointment must fit one
window; days without hours are closed) is built and tested. It is **not yet
switched on in the call path**, so today recording hours does not stop a
time outside them being offered. Turning it on is an activation your
GuideHerd contact performs (connecting the assistant to GuideHerd's
selection step) and proves with a test call. Until then, block never-book
times in your attorneys' calendars.

### Scheduling preferences

You can record preferences — preferred attorneys, preferred days, morning or
afternoon, preferred appointment length.

> Preferences are **designed to re-rank** the times your calendar system
> makes available — preferred attorneys, days, mornings/afternoons, and
> length push matching times to the front of what callers are offered (they
> never hide a time; business hours do that). Like business hours above,
> this re-ranking is built and tested but **not yet switched on in the call
> path**, so today setting a preference does not change what a caller is
> offered. It takes effect when your GuideHerd contact connects the
> assistant to GuideHerd's selection step. Availability itself always comes
> from your calendar system.

Also not available today: minimum notice before an appointment, buffers between
appointments, and per-type appointment lengths. None of these exist.

---

## Notifications

GuideHerd sends **email only.** No SMS, no text reminders, no push. If a caller
asks whether they'll get a text, the answer is no.

### What is sent by default

**Consultation summary — on.** After every call that reaches a conclusion —
booked, failed, or needed a person — a summary goes **to your firm**, not to the
caller. It carries the caller's details, what happened, and the appointment if
one was made.

This is your record of what happened on each call, and it's the notification most
worth watching in the first weeks.

### What is available but off

**Appointment confirmation to the caller — off by default, and deliberately so.**
Your calendar system already sends its own invitation to the caller. Turning
GuideHerd's on as well means **every caller gets two emails** about the same
appointment.

Only turn it on if you've confirmed your calendar system isn't already doing it.

**Appointment reminders — off by default.** Reminders before the appointment,
at intervals you choose (24 hours and 1 hour are the defaults). To use them:

- Turning them on **does not affect bookings already made.** Only appointments
  booked afterwards get reminders.
- Turning them off **does stop reminders already scheduled** — the setting is
  rechecked before each one goes out.
- A reminder whose time has already passed is skipped rather than sent late.
- Reminders only go to callers who gave an email address.

### Not available

**Cancellation and reschedule notifications do not exist**, because GuideHerd has
no cancellation or reschedule workflow. Changing an appointment happens in your
calendar system, and GuideHerd will not email anyone about it.

### When a notification fails

GuideHerd retries automatically, several times, with increasing delays.

**After the retries are exhausted, nothing further happens.** No alert, no email
to you, no ticket. The delivery is simply recorded as failed.

**This is why checking the Operations Center matters.** A failed notification is
silent, and the only way you'll find out is by looking. Make it a habit —
daily at first.

---

## Branding

Modest, and email-only. You can set:

- **Sender name** — how your firm is named in the email
- **Accent color** — a single line of color under the heading
- **Footer text** — the closing line
- **Logo** and an **office contact block** (phone, email, address)

Two things to be clear about:

- **The sender name does not change the address emails come from.** Emails send
  from the mailbox your deployment uses. Your firm's name appears *in* the
  message; the From address is GuideHerd's unless a firm-specific mailbox was
  set up at deployment. If email must come from your own domain, that's a
  deployment request.
- **Branding affects emails only.** There is no theming of the Reception
  Console, no custom colors, and no custom domain for the screens.

The consultation summary to your firm stays GuideHerd-branded regardless.

---

## When settings take effect

Configuration changes are **live immediately** — no restart, no redeploy. Make a
change, and the next call uses it.

Two protections worth knowing:

- **Nothing partially valid is ever saved.** A change with an error is rejected
  whole, so you can't half-apply something.
- **Two administrators can't silently overwrite each other.** If someone else
  changed something since you loaded the page, your save is refused with a
  message telling you to reload and retry. Reload, re-apply, save.

Every change is recorded — what changed, who changed it, and the before and
after. You can see recent changes in the Administration screen.

> **There is no undo.** The history shows what changed but cannot roll it back.
> To reverse something, change it back by hand. For anything significant, note
> the old value before you change it.

### One serious warning

**If your deployment is configured to reload its setup from a file at startup,
that file wins — and every change you made through the Administration screen is
silently reverted at the next restart.**

These two modes are mutually exclusive. Ask whoever runs your deployment which
one you're in **before** you make configuration changes you care about. If it's
the file mode, changes must go into that file, not the screen.

---

## Backup and recovery

Read this section properly. It's the one most likely to matter on a bad day.

### First, a distinction that matters

How much survives a restart **depends on how your firm's GuideHerd is set up.**
Some answers are the same everywhere; others are a deployment choice. Mixing
those up leads either to false comfort or to needless alarm, so this section
separates them.

- **Always true** — a guarantee of the GuideHerd software itself.
- **Depends on your setup** — determined by the storage your deployment uses.
- **Confirm with GuideHerd support** — a fact about *your* deployment that this
  documentation cannot know.

### Always true

**Booked appointments are never at risk from a GuideHerd restart.** They live in
your calendar system, which is the authoritative record. This is the guarantee
that matters most, and it holds in every configuration.

**Your firm's configuration survives.** Practice areas, attorneys, settings, and
the change history are stored durably, not in memory.

**Signed-in sessions now survive restarts** on GuideHerd's standard
production setup — operators and administrators stay signed in through a
restart or update. (On non-standard setups that keep sessions in memory, a
restart signs people out and they simply sign back in; nothing is lost
either way.)

**Consultation summaries are never stored.** The email that was delivered is the
only copy — there is no second copy to lose or to leak.

### Depends on your setup

Operational history — prepared sessions, notification delivery records, pending
reminders, and the Operations Center's recent activity — is held in whichever
operational store your deployment is configured to use.

| If your deployment uses… | Then on a restart… |
|---|---|
| **A durable database** | Operational history **survives**. Pending reminders still fire. Notification records remain visible. |
| **In-memory storage** | Operational history is **cleared**. Pending reminders are lost. The Operations Center starts over. |

Durable storage is fully built and is the recommended configuration. **Do not
assume you're on the in-memory option** — many deployments are not.

> **Ask GuideHerd support which one your firm uses.** It is a single question
> with a definite answer, and it changes what you should expect after every
> restart.

### Backups — confirm with GuideHerd support

**GuideHerd's software does not perform backups of its own.** Backup and restore
are properties of the storage your deployment is configured with — a managed
database typically provides automated backups and point-in-time recovery, while
a plain file on disk provides whatever the host provides and nothing more.

This documentation cannot tell you which applies to your firm. What it can tell
you is exactly what to ask:

- **Is my firm's configuration backed up? On what schedule?**
- **Is the operational database backed up, and does it support
  point-in-time recovery?**
- **Has a restore ever actually been performed and verified?**

**An untested backup is a hope, not a plan.** Get these answers in writing and
record them where your firm keeps its continuity documentation. If the answer to
any of them is "no" or "not sure," that is the finding — treat it as an open
item rather than an acceptable steady state.

### Data retention

**Automatic data retention is available but OFF until your firm turns it
on.** When enabled, it removes cancelled or unbooked sessions after about a
day and completed sessions after about a month; the delivered consultation
summary email remains your durable record of each call. It is deliberately
off by default so nothing is ever deleted without your firm's explicit
decision — ask your GuideHerd contact to enable it and to set your exact
windows. There is no self-service export or selective-erasure tool; for a
specific erasure request, ask your GuideHerd contact.

Two genuine points in GuideHerd's favor:

- **Consultation summaries are never stored.** The email that was delivered is
  the only copy.
- **Prepared sessions expire in 10 minutes**, so caller details don't sit around
  in a pending state.

There is no data-export-on-request tooling and no erasure command.

---

## Your routine

**Daily, at first:** open the Operations Center. Look for failed handoffs and
failed notifications. Both are silent failures — nobody is told, and you will
only find them by looking.

**Weekly:** ask your receptionist what's been awkward. They see the problems
first and often don't think to report them.

**Monthly:** check that practice areas, attorneys, and consultation types still
match how the firm actually works. Firms drift; the list should follow.

**Whenever staff change:** make the user change in the Administration screen
(Users card) — adding, deactivating, and role changes take effect immediately.

---

## Getting help

Have these ready:

- **What happened**, in the receptionist's words
- **When** — roughly is fine
- **The session ID or correlation ID** from the Operations Center if you can
  find it. This is by far the most useful thing you can provide; it lets
  GuideHerd trace exactly one call.
- **Whether it's happened before**, and how often

See the [Troubleshooting Guide](troubleshooting-guide.md) for things you can
resolve yourself.
