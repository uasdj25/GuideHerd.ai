# GuideHerd Legal Intake Copilot — Demo Script

**Duration:** ~10–15 minutes  
**Audience:** Law firm partners, operations managers, legal tech buyers  
**Setup:** `./start.sh` running, browser open to http://localhost:3001

---

## Opening (1 min)

> "Today I want to show you what happens from the moment a prospective client hits 'submit' on your intake form to the moment an attorney has everything they need to make a go/no-go decision. We're going to do that in under 60 seconds per lead, with zero data entry by staff."

---

## Scene 1 — The Dashboard (2 min)

Open the dashboard. Walk through:

- **Stats bar:** "Four numbers the intake coordinator checks every morning — total leads, what's pending review, how many are in scope, and any risk flags."

- **Lead cards:** "Each card tells you the client name, when they submitted, the practice area we classified them into, whether they're in scope, their urgency, and a confidence score on the classification."

- **Filters:** Click through `Pending`, `In Review`, `Accepted`. "Status is attorney-controlled — the system never moves a lead without a human decision."

- **Three leads pre-loaded:** "These are three fictional intakes we seeded. I'll walk through each one."

---

## Scene 2 — Margaret Chen (In-Scope, Estate Dispute) (4 min)

Click Margaret Chen's card.

**Header card:**
> "Margaret submitted a probate matter — 93% confidence, in scope, medium urgency."

**Analysis tab → Scope alert:**
> "Green bar: in scope. Classification: Probate & Estate. The attorney's job is to verify this before acting on it."

**Conflict-check names:**
> "We extracted Dorothy Chen, Kevin Chen, and James Whitfield from the free-text description. That's your conflict screening list. The system flags that it may be incomplete — there could be more parties."

**Missing information:**
> "The system noticed she didn't tell us the date of death or the county where the estate is being administered. Those are your first questions for the consultation call."

**Risk flags:**
> "No flags on this one — medium urgency, no impending deadlines mentioned, no prior attorney fee lien risk."

**Client description:**
> "Here's exactly what she wrote, verbatim. No paraphrasing that could change meaning."

Switch to **Drafts tab → Draft Client Email:**
> "This acknowledgment is waiting for attorney review. It's not sent. Notice the language — explicitly no attorney-client relationship, no legal advice, just 'we received it and we'll be in touch.' The attorney approves and sends."

Switch to **Attorney Summary:**
> "This is the one-pager the reviewing attorney gets. Matter overview table, conflict names, missing info checklist, risk flags, and a recommended next-steps list. It renders as formatted markdown and can be copied straight into your matter management system."

Switch to **JSON Output tab:**
> "Every intake is also saved as a structured JSON file for integration with your CMS, Clio, or any downstream system."

**Status update:**
> Click `In Review`. "Attorney clicks once — status updates across the board."

---

## Scene 3 — Antonio Rosario (In-Scope, Unpaid Invoice) (3 min)

Click Antonio Rosario.

> "Business litigation — unpaid $32,500. 78% confidence, in scope."

**Missing info:**
> "He mentioned the demand letter and the contract. But the system caught that we don't know the legal entity name of the other party — he said 'Pinnacle Property Group' but is it an LLC, Inc., or a sole prop? That matters for filing."

**Drafts → Client Email:**
> "The acknowledgment for an in-scope matter mentions the missing info items: 'it would be helpful to have the following ready when you call.'"

---

## Scene 4 — Derek Wilson (Out of Scope, DUI) (2 min)

Click Derek Wilson.

> "Here's where the system earns its keep on triage. Derek submitted a DUI matter — 81% confidence, Criminal Defense, out of scope."

**Scope alert (red):**
> "Red banner immediately. The system knows this firm doesn't do criminal defense."

**Drafts → Client Email:**
> "The out-of-scope acknowledgment is completely different — it tells him we can't help, gives him the State Bar referral, and is legally careful: no advice, no relationship implied. Still requires attorney sign-off before sending."

**Next steps:**
> "The attorney summary tells you exactly what to do: don't assign, send the out-of-scope email after review, provide the referral, close the intake."

---

## Scene 5 — Submit a New Intake Live (3 min)

Click **+ New Intake**.

> "Let's see it work in real time."

Fill in:
- First: `Jennifer`, Last: `Torres`
- Email: `jtorres@example.com`
- Phone: `555-212-0099`
- Matter description: *"My landlord has refused to return my security deposit of $3,200 after I moved out. I left the unit in good condition and gave 60 days notice. The landlord claims there was damage but won't provide any documentation. I have photos from move-in and move-out. The lease ended two months ago."*
- Parties: `Robert Kim (landlord)`
- Urgency: `Medium`

Click **Submit Intake →**

> "Watch the processing." — Lead detail view opens immediately.

> "Real estate, in scope, conflict name extracted — Robert Kim. Missing: the property address. That's right, she described the situation but didn't give us the address. The system caught it."

---

## Closing (1 min)

> "What you just saw: matter classification, conflict name extraction, missing info detection, risk flagging, draft communications — all from a single free-text submission. The attorney still makes every decision. The system just makes sure no lead falls through the cracks and no communication goes out without review."

> "The outputs directory has a JSON file and a Markdown attorney summary for every lead. Drop those into Clio, your email, or your matter intake Slack channel — whatever fits your workflow."

---

## Q&A Prompts

- *"What practice areas does it support?"* — Currently: Probate, Business/Commercial, Real Estate, Employment (in scope); Criminal, Immigration, Family Law (out of scope, with referral guidance). Fully configurable.
- *"Can it integrate with our existing software?"* — The JSON output is integration-ready. API endpoints are standard REST.
- *"What stops it from sending an email?"* — Nothing is wired to any email system. The draft is text only. A human copies and sends.
- *"How accurate is the classification?"* — For the three practice areas in scope, 80–95% on realistic intake descriptions. Low-confidence results are flagged for manual review.
- *"Is client data stored anywhere?"* — Demo only: local JSON file. Production version would use your preferred data store with appropriate encryption and access controls.
