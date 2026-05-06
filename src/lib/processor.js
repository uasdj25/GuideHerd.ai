/**
 * GuideHerd Legal Intake Processor — browser ES module
 *
 * Classifies matters, extracts conflict-check names, identifies missing info,
 * and generates draft communications entirely in the browser (no backend needed).
 *
 * IMPORTANT: This does NOT provide legal advice, decide conflicts, create
 * attorney-client relationships, or send any communications. All output is
 * draft-only and requires attorney review before any action is taken.
 */

const FIRM = 'Hargrove & Associates';
const FIRM_PHONE = '(555) 400-2200';
const FIRM_EMAIL = 'intake@hargrovelaw.example.com';

const PRACTICE_AREAS = {
  probate: {
    keywords: [
      'estate', 'probate', 'will', 'trust', 'inheritance', 'deceased',
      'decedent', 'executor', 'beneficiary', 'heir', 'intestate',
      'guardian', 'conservator', 'power of attorney', 'living will',
      'death', 'passed away', 'passed on', 'sibling', 'contest',
      'dispute', 'distribution', 'hospice',
    ],
    label: 'Probate & Estate',
    inScope: true,
    referralNote: null,
    missingChecks: [
      { pattern: /deceased|decedent|passed|died/i, label: 'Full legal name of the deceased' },
      { pattern: /died|death|passed|hospice/i, label: 'Date of death' },
      { pattern: /probate|estate|court|county/i, label: 'County and state where estate is being administered' },
      { pattern: /estate|assets|property|value/i, label: 'Estimated value of the estate' },
      { pattern: /will|testament/i, label: 'Whether a will exists and its current location' },
    ],
  },
  business: {
    keywords: [
      'invoice', 'contract', 'breach', 'business', 'unpaid', 'payment',
      'commercial', 'vendor', 'LLC', 'corporation', 'partnership',
      'services rendered', 'owe', 'owes', 'debt', 'outstanding balance',
      'billing', 'contractor', 'client refuses', 'non-payment',
      'net 30', 'purchase order', 'demand letter',
    ],
    label: 'Business & Commercial Litigation',
    inScope: true,
    referralNote: null,
    missingChecks: [
      { pattern: /contract|agreement|written/i, label: 'Whether a written contract exists' },
      { pattern: /\$|amount|owe|invoice|balance/i, label: 'Total dollar amount owed' },
      { pattern: /last|payment|paid|communic/i, label: 'Date of last payment or communication' },
      { pattern: /demand|letter|notice|certified/i, label: 'Whether a demand letter has been sent' },
      { pattern: /LLC|inc|corp|company|group/i, label: 'Legal entity name of the opposing party (LLC, Inc., etc.)' },
    ],
  },
  realEstate: {
    keywords: [
      'property', 'real estate', 'landlord', 'tenant', 'lease', 'deed',
      'mortgage', 'foreclosure', 'eviction', 'zoning', 'easement',
      'boundary', 'title', 'closing', 'security deposit',
    ],
    label: 'Real Estate',
    inScope: true,
    referralNote: null,
    missingChecks: [
      { pattern: /property|address|located/i, label: 'Full property address' },
      { pattern: /deed|title|ownership/i, label: 'Whether deed or title documents are available' },
      { pattern: /landlord|tenant|seller|buyer|owner/i, label: 'Full legal name of the other party' },
    ],
  },
  employment: {
    keywords: [
      'employment', 'fired', 'termination', 'wrongful termination',
      'discrimination', 'harassment', 'workplace', 'HR', 'employer',
      'employee', 'wage', 'overtime', 'EEOC', 'hostile work environment',
      'retaliation', 'laid off', 'OSHA',
    ],
    label: 'Employment Law',
    inScope: true,
    referralNote: null,
    missingChecks: [
      { pattern: /employer|company|work|corp/i, label: 'Full legal name of the employer' },
      { pattern: /terminat|fired|laid off|date/i, label: 'Date of termination or adverse action' },
      { pattern: /EEOC|charge|agency|filed/i, label: 'Whether an EEOC or state agency charge has been filed' },
    ],
  },
  criminal: {
    keywords: [
      'criminal', 'DUI', 'DWI', 'arrest', 'charges', 'felony',
      'misdemeanor', 'police', 'crime', 'assault', 'battery', 'theft',
      'drug', 'narcotics', 'indictment', 'arraignment', 'bail',
      'public defender', 'plea', 'sentence', 'conviction', 'probation',
      'parole', 'defendant', 'prosecution', 'BAC',
    ],
    label: 'Criminal Defense',
    inScope: false,
    referralNote:
      'Our firm does not handle criminal defense matters. We recommend contacting the State Bar Lawyer Referral Service for a criminal defense attorney.',
    missingChecks: [],
  },
  immigration: {
    keywords: [
      'immigration', 'visa', 'citizenship', 'deportation', 'green card',
      'asylum', 'USCIS', 'removal', 'work permit', 'naturalization',
    ],
    label: 'Immigration',
    inScope: false,
    referralNote:
      'Our firm does not handle immigration matters. We recommend contacting a Board of Immigration Appeals accredited representative or immigration attorney.',
    missingChecks: [],
  },
  familyLaw: {
    keywords: [
      'divorce', 'custody', 'child support', 'alimony', 'spousal support',
      'separation', 'adoption', 'domestic violence', 'restraining order',
    ],
    label: 'Family Law',
    inScope: false,
    referralNote:
      'Our firm does not currently handle family law matters. We recommend contacting the State Bar Lawyer Referral Service.',
    missingChecks: [],
  },
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyMatter(description = '', partiesInvolved = '') {
  const text = `${description} ${partiesInvolved}`.toLowerCase();
  const scores = {};

  for (const [key, cfg] of Object.entries(PRACTICE_AREAS)) {
    scores[key] = cfg.keywords.filter(kw => text.includes(kw.toLowerCase())).length;
  }

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const [topKey, topScore] = sorted[0];
  const [, secondScore] = sorted[1] ?? ['', 0];

  if (topScore === 0) {
    return {
      areaKey: 'unknown',
      label: 'General Inquiry / Unable to Classify',
      inScope: null,
      confidence: 0,
      referralNote: null,
      needsManualReview: true,
    };
  }

  const cfg = PRACTICE_AREAS[topKey];
  const raw = (topScore / cfg.keywords.length) * 100;
  const margin = topScore - secondScore;
  const confidence = Math.min(97, Math.round(raw * 0.6 + margin * 5 + 45));

  return {
    areaKey: topKey,
    label: cfg.label,
    inScope: cfg.inScope,
    confidence,
    referralNote: cfg.referralNote ?? null,
    needsManualReview: confidence < 60,
  };
}

// ---------------------------------------------------------------------------
// Conflict-check name extraction
// ---------------------------------------------------------------------------

export function extractConflictNames(intake) {
  const names = new Set();
  const clientName = `${intake.firstName ?? ''} ${intake.lastName ?? ''}`.trim();
  if (clientName) names.add(clientName);

  const parties = intake.partiesInvolved ?? '';
  if (parties) {
    parties.split(/[,;/\n]+/).map(s => s.trim()).filter(s => s.length > 2 && s.length < 80).forEach(n => names.add(n));
  }

  const skipPrefixes = ['Estate Of', 'State Of', 'Court Of', 'City Of', 'County Of', 'United States'];
  const namePattern = /(?<!\.\s)([A-Z][a-z]{1,15}\s[A-Z][a-z]{1,15}(?:\s[A-Z][a-z]{1,15})?)/g;
  let m;
  while ((m = namePattern.exec(intake.matterDescription ?? '')) !== null) {
    const candidate = m[1].trim();
    if (!skipPrefixes.some(p => candidate.startsWith(p))) {
      names.add(candidate);
    }
  }

  return [...names].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Missing info detection
// ---------------------------------------------------------------------------

export function identifyMissingInfo(intake, areaKey) {
  const missing = [];
  const combined = `${intake.matterDescription ?? ''} ${intake.partiesInvolved ?? ''}`;
  const area = PRACTICE_AREAS[areaKey];

  if (area?.missingChecks?.length) {
    for (const check of area.missingChecks) {
      if (!check.pattern.test(combined)) {
        missing.push(check.label);
      }
    }
  } else if (!intake.matterDescription || intake.matterDescription.length < 50) {
    missing.push('Detailed description of the legal matter');
  }

  const phone = (intake.phone ?? '').replace(/\D/g, '');
  if (phone.length < 7) missing.push('Valid callback phone number');
  if (!intake.urgency) missing.push('Urgency level / any pending court dates or deadlines');

  return missing;
}

// ---------------------------------------------------------------------------
// Risk flags
// ---------------------------------------------------------------------------

export function assessRiskFlags(intake) {
  const flags = [];
  const desc = (intake.matterDescription ?? '').toLowerCase();
  const urgency = (intake.urgency ?? '').toLowerCase();

  if (urgency === 'emergency' || urgency === 'high') {
    flags.push('HIGH URGENCY — client reports time-sensitive matter');
  }
  if (/court date|hearing|deadline|statute of limitations|sol|tomorrow|next week/i.test(desc)) {
    flags.push('Potential statute of limitations or upcoming deadline mentioned — verify immediately');
  }
  if (/prior attorney|previous lawyer|former counsel/i.test(desc)) {
    flags.push('Prior attorney involvement — obtain records and check for fee lien issues');
  }
  if (/pro se|representing myself|no lawyer/i.test(desc)) {
    flags.push('Client may be currently self-represented in active proceedings');
  }
  const amount = parseInt((intake.estimatedDamages ?? '').replace(/\D/g, ''), 10);
  if (!isNaN(amount) && amount > 100_000) {
    flags.push('High-value matter — conflicts check and malpractice insurance notification may be required');
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Draft acknowledgment email
// ---------------------------------------------------------------------------

export function generateAcknowledgmentEmail(intake, analysis) {
  const first = intake.firstName || 'there';
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  if (analysis.inScope === false) {
    return `Subject: Your Inquiry to ${FIRM} — Receipt Confirmed

Dear ${first},

Thank you for reaching out to ${FIRM}. We have received your inquiry submitted on ${today}.

After a preliminary review, it appears that your matter may fall outside the practice areas our firm currently handles. Specifically, matters involving ${analysis.label} are not areas in which our firm currently offers representation.

${analysis.referralNote ?? 'We encourage you to contact the State Bar Lawyer Referral Service for assistance finding qualified counsel.'}

IMPORTANT: This message does not constitute legal advice, and no attorney-client relationship has been formed between you and ${FIRM} by virtue of this communication or your submission of this inquiry. Please do not take or refrain from taking any legal action based on this message.

If you believe your matter has been incorrectly characterized, or if you have additional questions, please contact our office at ${FIRM_PHONE} or ${FIRM_EMAIL}.

We wish you the best in finding the representation you need.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
${FIRM}
${FIRM_PHONE} | ${FIRM_EMAIL}

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`;
  }

  const missingNote = analysis.missingInfo?.length
    ? `\nTo help us evaluate your matter efficiently, please have the following ready for your consultation call:\n\n${analysis.missingInfo.map(m => `  • ${m}`).join('\n')}\n`
    : '';

  return `Subject: Your Inquiry to ${FIRM} — Receipt Confirmed

Dear ${first},

Thank you for contacting ${FIRM}. We have received your inquiry submitted on ${today}.

A member of our team will review your matter and be in touch within [X] business days to discuss next steps. Please note that no attorney has been assigned to your matter at this time, and no attorney-client relationship has been formed.
${missingNote}
If your matter is urgent or you have an upcoming court date or deadline, please call our office immediately at ${FIRM_PHONE} so we can prioritize your inquiry.

IMPORTANT: This acknowledgment does not constitute legal advice, and no attorney-client relationship has been formed between you and ${FIRM} by virtue of this communication or your submission. The submission of this form does not obligate our firm to represent you.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
${FIRM}
${FIRM_PHONE} | ${FIRM_EMAIL}

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`;
}

// ---------------------------------------------------------------------------
// Attorney summary (Markdown)
// ---------------------------------------------------------------------------

export function generateAttorneySummary(intake, analysis) {
  const now = new Date().toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const scopeTag = analysis.inScope === true ? '✅ IN SCOPE'
    : analysis.inScope === false ? '🚫 OUT OF SCOPE'
    : '⚠️ NEEDS REVIEW';

  const missingList = analysis.missingInfo?.length
    ? analysis.missingInfo.map(m => `- [ ] ${m}`).join('\n')
    : '- None identified at this stage';

  const flagList = analysis.riskFlags?.length
    ? analysis.riskFlags.map(f => `- ⚠️ ${f}`).join('\n')
    : '- None identified';

  const conflictList = analysis.conflictNames?.length
    ? analysis.conflictNames.map(n => `- ${n}`).join('\n')
    : '- None extracted';

  const nextSteps = analysis.inScope === false
    ? `1. **Do not assign an attorney** — matter is outside firm's practice areas
2. Send the draft out-of-scope acknowledgment email (after attorney review)
3. Provide referral: ${analysis.referralNote ?? 'State Bar Referral Service'}
4. Close intake — no further action required`
    : `1. **Run full conflicts check** using extracted names above
2. Assign intake to practice group: **${analysis.label}**
3. ${analysis.missingInfo?.length ? 'Gather missing information (see above) during consultation call' : 'Schedule initial consultation call'}
4. Review and send draft acknowledgment email (after attorney approval)
5. Determine engagement letter requirements if matter is accepted`;

  const manualFlag = analysis.needsManualReview
    ? '\n> ⚠️ **Low confidence classification — attorney should review description directly.**\n'
    : '';
  const referralLine = analysis.referralNote
    ? `\n**Referral Guidance:** ${analysis.referralNote}\n`
    : '';

  return `# Attorney Intake Summary
## GuideHerd Legal Intake Copilot — CONFIDENTIAL WORK PRODUCT

> **This summary is generated for attorney review only. It does not constitute legal advice,
> establish an attorney-client relationship, or represent a conflict determination.**
> All items require attorney verification before any action is taken.

---

## Matter Overview

| Field | Value |
|-------|-------|
| **Prospective Client** | ${intake.firstName} ${intake.lastName} |
| **Submitted** | ${now} |
| **Contact Email** | ${intake.email ?? '—'} |
| **Contact Phone** | ${intake.phone ?? '—'} |
| **Urgency (Self-Reported)** | ${intake.urgency ?? 'Not specified'} |
| **Estimated Value** | ${intake.estimatedDamages ?? 'Not provided'} |
| **Prior Attorney** | ${intake.priorAttorney ?? 'None reported'} |
| **Referral Source** | ${intake.referralSource ?? 'Not specified'} |

---

## Classification ${scopeTag}

- **Practice Area:** ${analysis.label}
- **Confidence:** ${analysis.confidence}%
- **In-Scope:** ${analysis.inScope === true ? 'Yes' : analysis.inScope === false ? 'No' : 'Unclear — manual review required'}
${manualFlag}${referralLine}

---

## Client Description (Verbatim)

> ${(intake.matterDescription ?? '').replace(/\n/g, '\n> ')}

**Parties Identified by Client:** ${intake.partiesInvolved ?? 'None listed'}

---

## Conflict Check Names

*The following names were extracted for conflict screening. This list may be incomplete. Attorney must conduct a full conflict check before any substantive discussion.*

${conflictList}

---

## Missing Information

*The following items were not addressed in the intake and should be obtained before evaluating the matter:*

${missingList}

---

## Risk Flags

${flagList}

---

## Recommended Next Steps

${nextSteps}

---

*Generated by GuideHerd Legal Intake Copilot | ${now}*
*DRAFT — FOR ATTORNEY REVIEW ONLY — DO NOT DISTRIBUTE*`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function processIntake(intake) {
  const classification = classifyMatter(intake.matterDescription, intake.partiesInvolved);
  const conflictNames = extractConflictNames(intake);
  const missingInfo = identifyMissingInfo(intake, classification.areaKey);
  const riskFlags = assessRiskFlags(intake);

  const analysis = { ...classification, conflictNames, missingInfo, riskFlags };

  return {
    analysis,
    drafts: {
      acknowledgmentEmail: generateAcknowledgmentEmail(intake, analysis),
      attorneySummary: generateAttorneySummary(intake, analysis),
    },
  };
}
