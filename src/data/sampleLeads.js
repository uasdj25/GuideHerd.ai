/**
 * Pre-processed sample leads for the GuideHerd demo.
 * All names, emails, phone numbers, and facts are entirely fictional.
 * These leads are seeded into localStorage on first load so the demo
 * works immediately without any form submissions.
 */

export const SAMPLE_LEADS = [
  {
    id: 'demo-lead-001',
    submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'pending',
    notes: [],
    intake: {
      firstName: 'Margaret',
      lastName: 'Chen',
      email: 'margaret.chen@example.com',
      phone: '(555) 214-8830',
      matterDescription:
        'My mother, Dorothy Chen, passed away three months ago. She had a will that left her estate equally between me and my brother, Kevin Chen. The estate includes her home in Riverside County (valued around $480,000), a brokerage account, and some personal property. Kevin is now claiming that our mother signed a second, handwritten will two weeks before she died that leaves everything to him. He says she was of sound mind, but I have serious doubts — she had been in hospice care and was heavily medicated. The original will was drafted by attorney James Whitfield five years ago. I need to know if I can contest this second document and what the probate process looks like. No court proceedings have started yet.',
      partiesInvolved: 'Dorothy Chen (deceased), Kevin Chen (brother), James Whitfield (prior attorney)',
      estimatedDamages: '$480,000+',
      priorAttorney: 'James Whitfield (drafted original will, not representing me)',
      urgency: 'Medium',
      referralSource: 'Google Search',
    },
    analysis: {
      areaKey: 'probate',
      label: 'Probate & Estate',
      inScope: true,
      confidence: 93,
      referralNote: null,
      needsManualReview: false,
      conflictNames: [
        'Margaret Chen',
        'Dorothy Chen (deceased)',
        'Kevin Chen (brother)',
        'James Whitfield (prior attorney)',
        'Dorothy Chen',
        'Kevin Chen',
        'James Whitfield',
      ],
      missingInfo: [
        'Date of death',
        'County and state where estate is being administered',
      ],
      riskFlags: [
        'Prior attorney involvement — obtain records and check for fee lien issues',
      ],
    },
    drafts: {
      acknowledgmentEmail: `Subject: Your Inquiry to Hargrove & Associates — Receipt Confirmed

Dear Margaret,

Thank you for contacting Hargrove & Associates. We have received your inquiry.

A member of our team will review your matter and be in touch within [X] business days to discuss next steps. Please note that no attorney has been assigned to your matter at this time, and no attorney-client relationship has been formed.

To help us evaluate your matter efficiently, please have the following ready for your consultation call:

  • Date of death
  • County and state where estate is being administered

If your matter is urgent or you have an upcoming court date or deadline, please call our office immediately at (555) 400-2200 so we can prioritize your inquiry.

IMPORTANT: This acknowledgment does not constitute legal advice, and no attorney-client relationship has been formed between you and Hargrove & Associates by virtue of this communication or your submission. The submission of this form does not obligate our firm to represent you.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
Hargrove & Associates
(555) 400-2200 | intake@hargrovelaw.example.com

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`,
      attorneySummary: `# Attorney Intake Summary
## GuideHerd Legal Intake Copilot — CONFIDENTIAL WORK PRODUCT

> **This summary is generated for attorney review only. It does not constitute legal advice,
> establish an attorney-client relationship, or represent a conflict determination.**
> All items require attorney verification before any action is taken.

---

## Matter Overview

| Field | Value |
|-------|-------|
| **Prospective Client** | Margaret Chen |
| **Contact Email** | margaret.chen@example.com |
| **Contact Phone** | (555) 214-8830 |
| **Urgency (Self-Reported)** | Medium |
| **Estimated Value** | $480,000+ |
| **Prior Attorney** | James Whitfield (drafted original will, not representing me) |
| **Referral Source** | Google Search |

---

## Classification ✅ IN SCOPE

- **Practice Area:** Probate & Estate
- **Confidence:** 93%
- **In-Scope:** Yes

---

## Client Description (Verbatim)

> My mother, Dorothy Chen, passed away three months ago. She had a will that left her estate equally between me and my brother, Kevin Chen. The estate includes her home in Riverside County (valued around $480,000), a brokerage account, and some personal property. Kevin is now claiming that our mother signed a second, handwritten will two weeks before she died that leaves everything to him. He says she was of sound mind, but I have serious doubts — she had been in hospice care and was heavily medicated. The original will was drafted by attorney James Whitfield five years ago. I need to know if I can contest this second document and what the probate process looks like. No court proceedings have started yet.

**Parties Identified by Client:** Dorothy Chen (deceased), Kevin Chen (brother), James Whitfield (prior attorney)

---

## Conflict Check Names

*The following names were extracted for conflict screening. This list may be incomplete. Attorney must conduct a full conflict check before any substantive discussion.*

- Margaret Chen
- Dorothy Chen (deceased)
- Kevin Chen (brother)
- James Whitfield (prior attorney)
- Dorothy Chen
- Kevin Chen
- James Whitfield

---

## Missing Information

*The following items were not addressed in the intake and should be obtained before evaluating the matter:*

- [ ] Date of death
- [ ] County and state where estate is being administered

---

## Risk Flags

- ⚠️ Prior attorney involvement — obtain records and check for fee lien issues

---

## Recommended Next Steps

1. **Run full conflicts check** using extracted names above
2. Assign intake to practice group: **Probate & Estate**
3. Gather missing information (see above) during consultation call
4. Review and send draft acknowledgment email (after attorney approval)
5. Determine engagement letter requirements if matter is accepted

---

*Generated by GuideHerd Legal Intake Copilot*
*DRAFT — FOR ATTORNEY REVIEW ONLY — DO NOT DISTRIBUTE*`,
    },
  },

  {
    id: 'demo-lead-002',
    submittedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'in_review',
    notes: [
      {
        id: 'note-001',
        createdAt: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
        attorney: 'J. Hargrove',
        text: 'Called client. Has original signed contract and certified mail receipt. Scheduling consultation for next Tuesday. Need to verify Pinnacle\'s registered agent before filing.',
      },
    ],
    intake: {
      firstName: 'Antonio',
      lastName: 'Rosario',
      email: 'tony@rosarioscapes.example.com',
      phone: '(555) 309-7741',
      matterDescription:
        "I own a landscaping company, Rosario Landscapes LLC. Earlier this year I entered into a written contract with Pinnacle Property Group LLC to provide commercial landscaping services for a 12-month period across three of their properties in the metro area. Total contract value was $47,500. I performed all the work as specified. They paid the first two invoices ($15,000 total) but have not paid the remaining $32,500 despite three invoices and several emails. My last communication with their office manager was six weeks ago — they said the check was 'processing' and I've heard nothing since. I sent a formal demand letter via certified mail two weeks ago and have not received a response. I have the signed contract, all invoices, delivery confirmations, and the certified mail receipt. I want to sue if they don't pay.",
      partiesInvolved: 'Pinnacle Property Group LLC',
      estimatedDamages: '$32,500',
      priorAttorney: 'None',
      urgency: 'Medium',
      referralSource: 'Chamber of Commerce referral',
    },
    analysis: {
      areaKey: 'business',
      label: 'Business & Commercial Litigation',
      inScope: true,
      confidence: 78,
      referralNote: null,
      needsManualReview: false,
      conflictNames: [
        'Antonio Rosario',
        'Pinnacle Property Group LLC',
      ],
      missingInfo: [
        'Legal entity name of the opposing party (LLC, Inc., etc.)',
      ],
      riskFlags: [],
    },
    drafts: {
      acknowledgmentEmail: `Subject: Your Inquiry to Hargrove & Associates — Receipt Confirmed

Dear Antonio,

Thank you for contacting Hargrove & Associates. We have received your inquiry.

A member of our team will review your matter and be in touch within [X] business days to discuss next steps. Please note that no attorney has been assigned to your matter at this time, and no attorney-client relationship has been formed.

To help us evaluate your matter efficiently, please have the following ready for your consultation call:

  • Legal entity name of the opposing party (LLC, Inc., etc.)

If your matter is urgent or you have an upcoming court date or deadline, please call our office immediately at (555) 400-2200 so we can prioritize your inquiry.

IMPORTANT: This acknowledgment does not constitute legal advice, and no attorney-client relationship has been formed between you and Hargrove & Associates by virtue of this communication or your submission.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
Hargrove & Associates
(555) 400-2200 | intake@hargrovelaw.example.com

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`,
      attorneySummary: `# Attorney Intake Summary
## GuideHerd Legal Intake Copilot — CONFIDENTIAL WORK PRODUCT

> **This summary is generated for attorney review only. It does not constitute legal advice,
> establish an attorney-client relationship, or represent a conflict determination.**

---

## Matter Overview

| Field | Value |
|-------|-------|
| **Prospective Client** | Antonio Rosario |
| **Contact Email** | tony@rosarioscapes.example.com |
| **Contact Phone** | (555) 309-7741 |
| **Urgency (Self-Reported)** | Medium |
| **Estimated Value** | $32,500 |
| **Prior Attorney** | None |
| **Referral Source** | Chamber of Commerce referral |

---

## Classification ✅ IN SCOPE

- **Practice Area:** Business & Commercial Litigation
- **Confidence:** 78%
- **In-Scope:** Yes

---

## Client Description (Verbatim)

> I own a landscaping company, Rosario Landscapes LLC. Earlier this year I entered into a written contract with Pinnacle Property Group LLC to provide commercial landscaping services for a 12-month period across three of their properties in the metro area. Total contract value was $47,500. I performed all the work as specified. They paid the first two invoices ($15,000 total) but have not paid the remaining $32,500 despite three invoices and several emails. My last communication with their office manager was six weeks ago — they said the check was 'processing' and I've heard nothing since. I sent a formal demand letter via certified mail two weeks ago and have not received a response. I have the signed contract, all invoices, delivery confirmations, and the certified mail receipt. I want to sue if they don't pay.

**Parties Identified by Client:** Pinnacle Property Group LLC

---

## Conflict Check Names

- Antonio Rosario
- Pinnacle Property Group LLC

---

## Missing Information

- [ ] Legal entity name of the opposing party (LLC, Inc., etc.)

---

## Risk Flags

- None identified

---

## Recommended Next Steps

1. **Run full conflicts check** using extracted names above
2. Assign intake to practice group: **Business & Commercial Litigation**
3. Gather missing information (see above) during consultation call
4. Review and send draft acknowledgment email (after attorney approval)
5. Determine engagement letter requirements if matter is accepted

---

*Generated by GuideHerd Legal Intake Copilot*
*DRAFT — FOR ATTORNEY REVIEW ONLY — DO NOT DISTRIBUTE*`,
    },
  },

  {
    id: 'demo-lead-003',
    submittedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    status: 'referred',
    notes: [],
    intake: {
      firstName: 'Derek',
      lastName: 'Wilson',
      email: 'derek.wilson77@example.com',
      phone: '(555) 887-0023',
      matterDescription:
        "I was arrested last Saturday night for DUI. The officer said my BAC was 0.12. This is my first offense. I was driving home from a work event. I'm really worried about losing my license and what this means for my job — I drive for work. The arraignment is scheduled for next Thursday. I don't know if I need a private attorney or if I should use the public defender. I've never been in trouble before and I just want this to go away as quietly as possible.",
      partiesInvolved: 'State v. Derek Wilson',
      estimatedDamages: 'N/A',
      priorAttorney: 'None',
      urgency: 'High',
      referralSource: 'Friend recommendation',
    },
    analysis: {
      areaKey: 'criminal',
      label: 'Criminal Defense',
      inScope: false,
      confidence: 81,
      referralNote:
        'Our firm does not handle criminal defense matters. We recommend contacting the State Bar Lawyer Referral Service for a criminal defense attorney.',
      needsManualReview: false,
      conflictNames: ['Derek Wilson', 'State v. Derek Wilson'],
      missingInfo: [],
      riskFlags: [
        'HIGH URGENCY — client reports time-sensitive matter',
        'Potential statute of limitations or upcoming deadline mentioned — verify immediately',
      ],
    },
    drafts: {
      acknowledgmentEmail: `Subject: Your Inquiry to Hargrove & Associates — Receipt Confirmed

Dear Derek,

Thank you for reaching out to Hargrove & Associates. We have received your inquiry.

After a preliminary review, it appears that your matter may fall outside the practice areas our firm currently handles. Specifically, matters involving Criminal Defense are not areas in which our firm currently offers representation.

Our firm does not handle criminal defense matters. We recommend contacting the State Bar Lawyer Referral Service for a criminal defense attorney.

IMPORTANT: This message does not constitute legal advice, and no attorney-client relationship has been formed between you and Hargrove & Associates by virtue of this communication or your submission of this inquiry. Please do not take or refrain from taking any legal action based on this message.

If you believe your matter has been incorrectly characterized, or if you have additional questions, please contact our office at (555) 400-2200 or intake@hargrovelaw.example.com.

We wish you the best in finding the representation you need.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
Hargrove & Associates
(555) 400-2200 | intake@hargrovelaw.example.com

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`,
      attorneySummary: `# Attorney Intake Summary
## GuideHerd Legal Intake Copilot — CONFIDENTIAL WORK PRODUCT

> **This summary is generated for attorney review only. It does not constitute legal advice,
> establish an attorney-client relationship, or represent a conflict determination.**

---

## Matter Overview

| Field | Value |
|-------|-------|
| **Prospective Client** | Derek Wilson |
| **Contact Email** | derek.wilson77@example.com |
| **Contact Phone** | (555) 887-0023 |
| **Urgency (Self-Reported)** | High |
| **Estimated Value** | N/A |
| **Prior Attorney** | None |
| **Referral Source** | Friend recommendation |

---

## Classification 🚫 OUT OF SCOPE

- **Practice Area:** Criminal Defense
- **Confidence:** 81%
- **In-Scope:** No

**Referral Guidance:** Our firm does not handle criminal defense matters. We recommend contacting the State Bar Lawyer Referral Service for a criminal defense attorney.

---

## Client Description (Verbatim)

> I was arrested last Saturday night for DUI. The officer said my BAC was 0.12. This is my first offense. I was driving home from a work event. I'm really worried about losing my license and what this means for my job — I drive for work. The arraignment is scheduled for next Thursday. I don't know if I need a private attorney or if I should use the public defender. I've never been in trouble before and I just want this to go away as quietly as possible.

**Parties Identified by Client:** State v. Derek Wilson

---

## Conflict Check Names

- Derek Wilson
- State v. Derek Wilson

---

## Missing Information

- None identified at this stage

---

## Risk Flags

- ⚠️ HIGH URGENCY — client reports time-sensitive matter
- ⚠️ Potential statute of limitations or upcoming deadline mentioned — verify immediately

---

## Recommended Next Steps

1. **Do not assign an attorney** — matter is outside firm's practice areas
2. Send the draft out-of-scope acknowledgment email (after attorney review)
3. Provide referral: State Bar Lawyer Referral Service
4. Close intake — no further action required

---

*Generated by GuideHerd Legal Intake Copilot*
*DRAFT — FOR ATTORNEY REVIEW ONLY — DO NOT DISTRIBUTE*`,
    },
  },
];
