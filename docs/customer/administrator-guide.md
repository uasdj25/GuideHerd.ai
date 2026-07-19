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

**There is no user management screen.** This is the biggest gap in GuideHerd
today, and you should plan around it rather than be surprised by it.

Users are defined in deployment configuration. **Adding a person, removing a
person, or changing someone's role requires an environment change and a service
restart** — performed by whoever runs your infrastructure, not by you in a
browser.

What that means practically:

- **Staff changes need lead time.** A new receptionist can't be set up in the
  five minutes before their first shift. Batch them where you can.
- **Offboarding is not instant.** Removing someone who has left requires the
  same change-and-restart cycle. If it's urgent, say so — it needs a person, not
  a form.
- **A restart signs everyone out.** Harmless mid-shift — people sign back in —
  but do it deliberately rather than during the Monday morning rush.

There is no self-service password reset, no invitations, no self-registration,
and no multi-factor authentication. Sign-in uses an issued credential rather
than a password.

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
- A service restart signs everyone out

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

Attorney **ordering** within a group is adjustable, and it's the one part of
routing you can change yourself.

> **Limitation:** practice areas and attorneys are **display-only** in the
> Administration screen. You can see them; you cannot add or edit them there.
> Changes go through whoever manages your deployment. Expect this to improve.

### Consultation types

The kinds of appointment your firm offers — new matter, follow-up, existing
client. Firm-wide, not per practice area. Your receptionist must pick one on
every call; there's no "unspecified" option.

> **Limitation:** there is **no screen for consultation types.** They are set up
> at deployment. Changing them requires your GuideHerd contact.

### Offices and business hours

Locations and opening hours can be recorded through the underlying interface,
but there is **no screen for either**, and — importantly — **business hours are
stored but not currently used to decide anything.** Recording them does not stop
an appointment being offered outside them.

Don't rely on business hours as a control. If it matters that appointments only
land in certain windows, raise it as a requirement rather than assuming the
setting does it.

### Scheduling preferences

You can record preferences — preferred attorneys, preferred days, morning or
afternoon, preferred appointment length.

> **Be clear-eyed about this one: these preferences are saved and validated, but
> they do not yet influence what gets booked.** The part of GuideHerd that would
> apply them to real availability isn't connected. Availability comes from your
> calendar system.
>
> Setting them does no harm and they'll take effect when that connection lands.
> But if you set a preference and bookings ignore it, the system isn't broken —
> it just isn't wired up yet.

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

A logo and an office contact block are supported but have no screen yet.

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

**Everyone is signed out.** Login sessions are held in memory in every current
deployment. People sign back in; nothing is lost. This is the one restart effect
that is the same everywhere.

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

**Automatic deletion of old caller data is not implemented.**

There are intended defaults — clearing abandoned sessions after a day, removing
caller contact details from completed sessions after a month — but the job that
would do it **has not been built.** Nothing is deleted automatically today.

If your firm has a retention obligation, you need a **written manual procedure**:
who deletes what, how often, and how it's done. Agree it with your GuideHerd
contact and record it. Don't assume the platform is handling it.

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

**Whenever staff change:** raise user changes early — they need a deployment
change and a restart.

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
