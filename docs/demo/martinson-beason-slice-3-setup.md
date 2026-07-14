# Martinson & Beason Demo — Slice 3 External Setup Guide

Manual configuration steps for **David and Ryan**. Everything in this guide
lives *outside* the repository. Never commit real secrets, tenant IDs, client
IDs, mailbox addresses, or agent credentials to the repo.

**What the demo does:** receptionist prepares a caller in GuideHerd Console →
the GuideHerd Scheduling Assistant connects to the prepared session and
confirms the details instead of re-collecting them → the existing calendar
integration books the appointment → the assistant reports the outcome →
GuideHerd emails the Consultation Summary through the configured Outlook
mailbox. **No phone transfer occurs** — the caller speaks to the assistant on
its own page.

---

## 1. Generate the bridge secret

```bash
openssl rand -base64 48
```

This is the `DEMO_BRIDGE_SECRET`. It goes in exactly two places: the API's
environment (step 4) and the assistant runtime's server-tool headers (steps
2–3). It is temporary demo infrastructure, not production authentication.

## 2. Scheduling Assistant — "connect" server tool

> The steps below configure the **external AI Employee runtime (Lex)** that
> powers the GuideHerd Scheduling Assistant. This is adapter/runtime
> configuration, not GuideHerd public architecture. Ryan owns the assistant's
> dashboard.

In the assistant's tool configuration, add a **server tool**:

- **Name:** `get_prepared_caller`
- **Description (for the assistant):** "Fetch the caller the receptionist has
  prepared for this scheduling session. Call this once at the very start of
  every conversation, before speaking."
- **Method/URL:** `POST https://api.guideherd.ai/api/v1/demo/connect`
- **Headers:** `Authorization: Bearer <DEMO_BRIDGE_SECRET>`
- **Body:** the endpoint needs no body, but the runtime's webhook UI requires
  at least one JSON property on POST tools — configure a fixed body of
  `{"request": "connect"}`. The API accepts and **ignores** any body here.
- Expected responses: `200` with caller/scheduling context (see
  `docs/api/demo-bridge.md`); `404 no_prepared_session` (no one is prepared);
  `409 ambiguous_prepared_sessions` (receptionist must cancel extras).

## 3. Scheduling Assistant — outcome tool + prompt updates

Add a second **server tool**:

- **Name:** `report_scheduling_outcome`
- **Description:** "Report the final scheduling result for this session. Call
  this exactly once, only after the calendar booking tool has returned success
  or failure."
- **Method/URL:** `POST https://api.guideherd.ai/api/v1/demo/outcome`
- **Headers:** `Authorization: Bearer <DEMO_BRIDGE_SECRET>`
- **Body:** use the **flat format** (the webhook editor cannot build nested
  objects; the API accepts flat and lifts it internally — see
  `docs/api/demo-bridge.md`). Configure these body properties as
  **LLM-provided parameters** with descriptions:
  - `sessionId` (string, required) — "the sessionId returned by
    get_prepared_caller; copy it exactly"
  - `status` (string, required) — "booked, failed, or escalated"
  - `appointment` (object; required when booked) — `startsAt` (full ISO-8601
    with UTC offset or Z), `timezone` (IANA identifier such as
    America/Chicago), optional `attorneyId`, `consultationTypeId`
  - `reason` (string, optional) — "one neutral sentence describing the
    scheduling result; no legal detail"

Update the assistant's playbook/prompt so that it:

1. Calls `get_prepared_caller` at conversation start.
2. **Confirms** the supplied details naturally instead of re-collecting them
   ("I have you down as Ryan, reachable at ryan@…, hoping to meet with Clay
   Martinson about a personal injury matter — did I get that right?").
3. Accepts corrections gracefully.
4. Stays strictly on scheduling — no legal advice, no legal intake.
5. Books through its existing calendar tool exactly as it does today.
6. Calls `report_scheduling_outcome` **only after** the calendar tool returns
   success (`status: "booked"` with the confirmed start time and timezone) or
   failure (`status: "failed"`), or when the request can't be scheduled and a
   human must follow up (`status: "escalated"`).
7. Never mentions tokens, session IDs, vendors, internal system names, or
   runtime details to the caller.

If `get_prepared_caller` returns `404`, the assistant should say it doesn't
have a prepared caller yet and ask the receptionist (i.e., the demo operator)
to prepare one in GuideHerd Console.

## 4. API environment (Railway)

Add to the `api.guideherd.ai` service and redeploy:

| Variable | Value |
|---|---|
| `DEMO_BRIDGE_SECRET` | from step 1 |
| `MS_TENANT_ID` | Entra tenant ID (step 5) |
| `MS_CLIENT_ID` | app registration client ID (step 5) |
| `MS_CLIENT_SECRET` | app registration client secret (step 5) |
| `SUMMARY_MAILBOX` | sending mailbox, e.g. the GuideHerd M365 mailbox |
| `SUMMARY_RECIPIENT` | Martinson & Beason recipient for the summary |
| `CORS_ALLOWED_ORIGINS` | must include `https://guideherd.ai` |

Missing mail variables do not break the API — outcome calls simply return
`summaryDelivery: "not-configured"`.

## 5. Microsoft Entra app registration (David)

1. Entra admin center → App registrations → **New registration** (single
   tenant). No redirect URI needed.
2. Record the **Application (client) ID** and **Directory (tenant) ID**.
3. Certificates & secrets → **New client secret** → record the value.
4. API permissions → **Microsoft Graph → Application permissions →
   `Mail.Send`** → **Grant admin consent**.
5. Recommended hardening: restrict the app to the sending mailbox with an
   Exchange Online application access policy, so `Mail.Send` cannot send from
   any other mailbox.

## 6. Mailboxes

- `SUMMARY_MAILBOX` must be a real licensed mailbox (or shared mailbox) in the
  tenant — Graph sends as this identity.
- `SUMMARY_RECIPIENT` is the demo audience address (a Martinson & Beason
  contact for the live demo; use your own address for rehearsals).

## 7. Rehearsal (synthetic caller only — never real client information)

1. Open `https://guideherd.ai/receptionist/` — prepare a synthetic caller
   (fake name, an email you control, Clay Martinson).
2. Console shows **Ready to transfer** with the countdown.
3. Open `https://guideherd.ai/demo/martinson-beason/` → **Begin Scheduling
   Demonstration** → the assistant should *confirm* the prepared details, not
   re-collect them. Console flips to **Caller connected**.
4. Book a time. When the assistant reports the outcome, Console flips to
   **Appointment booked** with date/time/timezone.
5. Confirm the **GuideHerd Consultation Summary** email arrives in the
   recipient inbox, and the appointment exists on the calendar.
6. Also rehearse: cancel from the Console before connecting; and prepare two
   sessions at once to see the ambiguity refusal, then cancel one.

Operational notes for demo day: prepare the session fresh at demo time
(sessions live in memory — an API restart/deploy clears them, and each session
expires after 10 minutes); keep exactly **one** prepared session at a time.

## 8. Viewing the Consultation Summary without email (temporary)

Until the Microsoft Graph mailbox (steps 4–6) is configured, outcome calls
return `summaryDelivery: "not-configured"` and no email is sent. To still show
the **GuideHerd Consultation Summary** during the demo, the operator can fetch
the latest completed summary directly from the API:

```bash
# 1. Paste the secret into the terminal environment (never into a URL,
#    browser, bookmark, or file):
read -rs DEMO_BRIDGE_SECRET   # paste the secret, press Enter

# 2. Fetch the latest summary and open it locally:
curl -sf https://api.guideherd.ai/api/v1/demo/summary/latest \
  -H "Authorization: Bearer $DEMO_BRIDGE_SECRET" \
  -o /tmp/guideherd-summary.html \
  && open /tmp/guideherd-summary.html   # Linux: xdg-open
```

Rules for this workflow:

- The secret travels only in the `Authorization` header from your own
  terminal. **Never** put it in a URL, a browser page, a shared script, or a
  committed file, and never build a public "view summary" button around it.
- The endpoint returns the summary for the **most recently completed** session
  only, and `404 no_completed_summary` before any outcome has been recorded.
- Fetch it **promptly after the outcome**: summaries live in API memory, so a
  Railway restart or deploy erases them.
- This is temporary demo infrastructure. Once Graph mail delivery works,
  stop using it; it is removed with the rest of the bridge in the teardown
  step below.
- Delete `/tmp/guideherd-summary.html` after the demo — it contains the
  caller's contact details.

## 9. After the demo

1. **Rotate `DEMO_BRIDGE_SECRET`** (or unset it — unsetting disables the
   bridge endpoints with a controlled `503`).
2. When production telephony delivery of the handoff token lands, **remove the
   demo endpoints and `server/handoff/demo-bridge.js` entirely**, and delete
   the assistant's demo server tools.
