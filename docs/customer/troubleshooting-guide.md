# Troubleshooting Guide

Symptoms, what causes them, and what to do.

Organized by what you'd actually notice, not by which part of the system is
involved.

---

## Start here

Three questions resolve most problems:

1. **Is it one call or every call?** One call is usually a caller-specific
   issue. Every call is configuration or an outage.
2. **When did it start?** If it began after a change, that change is the
   suspect. If it began after a restart, see the restart section.
3. **What does the Operations Center say?** Look before you theorize.

---

## Reception Console problems

### "We couldn't load the firm's scheduling options"

The console can't reach GuideHerd or your firm's setup is missing.

**Affects every receptionist, not just one.** Treat it as urgent.

1. Select **Try Again**.
2. Check whether other people have it too. If yes, it's the service or the setup,
   not the machine.
3. Have receptionists take details by hand meanwhile — nothing is lost, calls
   just go the old way.
4. Contact GuideHerd.

**Common cause after a restart:** if your deployment doesn't keep its
configuration between restarts, the firm's setup can come back empty. It looks
like a network problem but it's a setup problem.

### The Prepare button won't light up

One of the four required fields is missing: caller name, email, practice area, or
consultation type. The email must also look like a real address.

Not a fault — the button is waiting.

### "No Attorneys Configured"

That practice area has no attorneys routed to it.

Sessions can still be prepared. But it means your setup is incomplete — fix the
routing. See the [Configuration Guide](configuration-guide.md).

### Sessions keep expiring before transfer

The transfer window is 10 minutes.

If it's regularly running out, the issue is usually process, not software:
receptionists preparing the session too early, or long hold times before
transfer. Prepare *just before* transferring, not at the start of the call.

### "We temporarily lost contact with the scheduling service"

The console lost track of a session that may still be running.

**Don't rebook.** The appointment may have booked. Check the Operations Center or
the consultation summary email before doing anything — double-booking a caller is
worse than waiting a minute to check.

### The console forgot everything after a refresh

Expected. Refreshing clears the session on screen. The session itself expires
shortly after, so nothing is stuck — prepare again.

---

## Booking problems

### "Scheduling could not be completed"

The assistant couldn't book. The caller still needs help.

**Once:** the receptionist takes details by hand; the firm follows up.

**Repeatedly:** something is wrong. Check whether it's one practice area or
attorney (likely a routing or calendar problem) or all of them (likely the
calendar connection). Contact GuideHerd with a session ID.

### "Human assistance required"

Working as intended. The assistant judged that this caller needs a person. The
receptionist takes the call back.

If it's happening constantly, tell GuideHerd — the threshold may need looking at.

### The appointment is at the wrong time

**Check your firm's timezone first.** It's the most common cause and it makes
everything *look* right while being consistently wrong.

If the timezone is correct and times are still off, contact GuideHerd with a
session ID and the expected versus actual time.

### A booking ignored our scheduling preferences

**Expected today.** Scheduling preferences are saved but not yet applied to real
bookings — availability comes from your calendar system, and the part that would
rank it against your preferences isn't connected.

Nothing is broken. See the [Configuration Guide](configuration-guide.md).

The same applies to business hours: recording them does not prevent appointments
outside them.

---

## Email problems

### The caller says they never got a confirmation

In likelihood order:

1. **The email address was wrong.** By far the most common cause. Check what was
   entered against what the caller says.
2. **It's in their spam folder.** Ask them to look.
3. **Delivery failed.** Check the Operations Center's notification deliveries.
   `failed` means retries were exhausted and **nobody was told.**
4. **Caller confirmations are off.** They're off by default — your calendar
   system's own invitation may be the only email the caller gets. Check whether
   they received *that*.

**Prevention:** have receptionists read the email address back on every call.
Five seconds, and it prevents the most common failure in the system.

### Nothing at all is being emailed

Check the Operations Center. If deliveries show **not-configured**, email isn't
set up on the deployment — a deployment problem, not a per-message one. Contact
GuideHerd.

### Callers are getting two confirmation emails

Caller confirmations are enabled *and* your calendar system is sending its own.

Turn off GuideHerd's appointment confirmation. See the
[Configuration Guide](configuration-guide.md).

### Reminders aren't going out

Check in order:

1. Are reminders enabled? Off by default.
2. Was the appointment booked **after** you enabled them? Enabling doesn't
   backfill existing bookings.
3. Did the caller give an email address? No email, no reminder.
4. Had the reminder time already passed when the booking was made? Those are
   skipped rather than sent late.

### Emails come from the wrong address

Expected. The sender name setting changes how your firm is named *in* the
message, not the address it comes from.

Own-domain email requires a firm-specific mailbox set up at deployment. Ask
GuideHerd.

---

## Configuration problems

### My settings reverted on their own

**Almost certainly the deployment reloads its setup from a file at startup.** In
that mode the file wins and Administration changes are silently reverted on
restart.

Ask GuideHerd which mode you're in. If it's file mode, changes must go into the
file.

### "The configuration was changed by someone else"

Another administrator saved something after you loaded the page. This is the
system preventing a silent overwrite.

Reload, re-apply your change, save again.

### I can't edit practice areas or attorneys

Expected. They're display-only in Administration today. Changes go through
GuideHerd.

### I need to undo a change

There's no undo. History shows what changed, including the previous value —
change it back by hand using that record.

---

## Access problems

### A receptionist can't sign in

1. Have they been provisioned? Users are set up at deployment, not in a screen.
2. Is the credential exactly right? It's an issued credential, not a password —
   no reset, no self-service.
3. Did the service restart? Restarts sign everyone out. Signing back in is the
   fix.
4. Been more than 12 hours since they signed in? Sessions expire absolutely,
   regardless of activity. Signing back in is the fix.

### An administrator can't see the Operations Center

Expected. **Roles don't nest.** Administrator does not include operator. They
need both roles assigned.

### Someone has left and still has access

Removing them needs a deployment change and a restart. **There is no instant
revoke.** If it's urgent, say so explicitly when you raise it.

---

## After a restart

**Always true, in every deployment:**

- **Booked appointments are unaffected** — they're in your calendar system.
- **Your firm's configuration is unaffected** — it's stored durably.
- **Everyone is signed out.** Login sessions are held in memory. People sign
  back in; nothing is lost.

**Depends on your deployment:** whether operational history — prepared sessions,
notification records, pending reminders, recent Operations Center activity —
survives.

- On a **durable database**, it survives and pending reminders still fire.
- On **in-memory storage**, it's cleared and the Operations Center starts over.

If the Operations Center looks unexpectedly empty after a restart, that's the
likely explanation — but only on an in-memory deployment. **Ask GuideHerd
support which storage your firm uses** before concluding data was lost; on a
durable deployment, an empty Operations Center means something else.

---

## When to contact GuideHerd

Contact them for: repeated booking failures, `not-configured` notifications,
anything affecting every receptionist, settings reverting, user changes, and
anything you can't explain.

**Have ready:**

- What happened, in the receptionist's words
- Roughly when
- **The session ID or correlation ID** from the Operations Center — by far the
  most useful thing you can provide
- Whether it's happened before, and how often
- Anything that changed recently
