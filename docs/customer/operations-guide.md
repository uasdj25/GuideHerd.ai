# Operations Guide

The Operations Center is where you see what GuideHerd has been doing.

It is **read-only**. There are no buttons that change anything — it's a window,
not a control panel. Everything you change lives in Administration.

---

## Getting in

Sign-in is always required — the Operations Center is never open. You need the
**operator** role.

Being an administrator does **not** give you access. Roles don't nest. If you
need both, you need both roles assigned.

You see your own firm's information and no one else's.

---

## Two things to know before you rely on it

**It doesn't refresh itself.** The page loads once. Nothing updates while you
watch it, and there's no refresh button — **reload the browser page** to see
current information. It's a review tool, not a live wallboard.

**Whether history survives a restart depends on your deployment.** On a durable
database — the recommended configuration — session and notification records
persist across restarts. On in-memory storage they're cleared and the page
starts over.

Booked appointments are unaffected either way; those live in your calendar
system. If you're investigating something and the history looks unexpectedly
short, a restart on an in-memory deployment is one explanation — but confirm
with GuideHerd support which storage your firm uses before assuming that's it.

One part is ephemeral regardless: the detailed event feed keeps only recent
activity, so it is not a long-term audit trail in any configuration.

---

## What's on the page

### Handoffs

Four counters: pending, active, completed, and failed.

**Failed is the one to watch**, and it highlights when it isn't zero. A failed
handoff means a caller didn't get an appointment booked.

### Search

Look up a specific call by session ID, correlation ID (starting `gh-`), or
attorney.

**This is the tool for investigating one specific complaint.** When a caller says
"I called Tuesday and never heard anything," this is how you find that call.

### Recent handoffs

The last 25 sessions: what happened, which attorney and practice area, whether
the summary went out, and the timeline — created, connected, completed,
cancelled.

Only the last 25. There's no date filter and no export.

### Notification deliveries

The last 25 notifications: type, session, and status.

| Status | Meaning |
|---|---|
| **sent** | Delivered. Final — it will never send twice. |
| **failed** | Retries exhausted. **Nobody was told.** |
| **not-configured** | Email isn't set up on this deployment |
| **pending** | In progress |

**`failed` deserves your attention.** Retries have already happened; this is the
end of the line, and no alert was raised. If it's a consultation summary, your
firm never got its record of that call. If it's a caller notification, the caller
never heard from you.

**`not-configured` is a deployment problem, not a per-message one.** It means no
email is going out at all. One of these is a wasted evening; many is an outage.

You can see *that* something failed, but not the message content, the recipient,
or the specific reason — that detail sits in the server logs. Your GuideHerd
contact can retrieve it from a session ID.

### Recent errors and warnings

Problems only. **Empty is good.**

### Operational events

A detailed activity feed with correlation IDs. Mostly useful when you're working
with GuideHerd support on a specific problem — **quote the correlation ID** and
they can trace exactly that call.

### System health

Whether GuideHerd's own parts are working: available, unavailable, or
not-configured.

This is about GuideHerd's capabilities, not your servers. There's no CPU, memory,
latency, or uptime here.

---

## What you won't find

Worth knowing so you don't hunt for it:

- **No caller names, emails, or phone numbers.** These are deliberately removed
  before anything reaches this screen. Operators see what happened, never who it
  happened to. To reach a specific caller, use the consultation summary email —
  that's where their details are.
- No charts, trends, or history beyond the recent lists
- No export or reporting
- No date-range filtering
- No alerting — **nothing notifies you**; you have to look

---

## Using it well

**Daily, especially early on:** check failed handoffs and failed notifications.
Both fail silently. Looking is the only detection mechanism there is.

**When someone complains:** search the session or correlation ID, check what the
status says, and check whether the notification went out. Most complaints resolve
to one of: it failed and nobody noticed, the email address was wrong, or it
worked and the caller missed the email.

**Before calling support:** get the session ID or correlation ID. It's the single
most useful thing you can hand over.

**Watch for patterns.** One failure is noise. The same failure three times in a
week is a setup problem — often a practice area with no attorneys, or an email
configuration that's silently broken.
