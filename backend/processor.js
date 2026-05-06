/**
 * GuideHerd Legal Intake Processor
 *
 * Rule-based engine that classifies matters, extracts conflict-check names,
 * identifies missing information, and generates draft communications.
 *
 * IMPORTANT: This processor does NOT provide legal advice, decide conflicts,
 * or create attorney-client relationships. All output is for attorney review only.
 */

const PRACTICE_AREAS = {
  probate: {
    keywords: [
      'estate', 'probate', 'will', 'trust', 'inheritance', 'deceased', 'decedent',
      'executor', 'beneficiary', 'heir', 'intestate', 'guardian', 'conservator',
      'power of attorney', 'living will', 'death', 'passed away', 'passed on',
      'sibling', 'contest', 'dispute', 'distribution'
    ],
    label: 'Probate & Estate',
    inScope: true,
    missingChecks: [
      { key: 'deceasedName', label: "Full legal name of the deceased", pattern: /deceased|decedent|passed/i },
      { key: 'dateOfDeath', label: "Date of death", pattern: /died|death|passed/i },
      { key: 'countyState', label: "County and state where estate is being administered", pattern: /probate|estate|court/i },
      { key: 'estateValue', label: "Estimated value of the estate", pattern: /estate|assets|property/i },
      { key: 'willExists', label: "Whether a will exists and its current location", pattern: /will|testament/i },
    ]
  },
  business: {
    keywords: [
      'invoice', 'contract', 'breach', 'business', 'unpaid', 'payment', 'commercial',
      'vendor', 'LLC', 'corporation', 'partnership', 'services rendered', 'owe',
      'owes', 'debt', 'collections', 'outstanding balance', 'invoice', 'billing',
      'contractor', 'client refuses', 'non-payment', 'net 30', 'purchase order'
    ],
    label: 'Business & Commercial Litigation',
    inScope: true,
    missingChecks: [
      { key: 'contractExists', label: "Whether a written contract exists", pattern: /contract|agreement|written/i },
      { key: 'amountOwed', label: "Total dollar amount owed", pattern: /\$|amount|owe|invoice/i },
      { key: 'lastPayment', label: "Date of last payment or communication", pattern: /last|payment|paid/i },
      { key: 'demandLetter', label: "Whether a demand letter has been sent", pattern: /demand|letter|notice/i },
      { key: 'otherPartyEntity', label: "Legal entity name of the opposing party (LLC, Inc., etc.)", pattern: /LLC|inc|corp|company/i },
    ]
  },
  realEstate: {
    keywords: [
      'property', 'real estate', 'landlord', 'tenant', 'lease', 'deed', 'mortgage',
      'foreclosure', 'eviction', 'zoning', 'easement', 'boundary', 'title', 'closing'
    ],
    label: 'Real Estate',
    inScope: true,
    missingChecks: [
      { key: 'propertyAddress', label: "Full property address", pattern: /property|address|located/i },
      { key: 'ownershipDocs', label: "Whether deed or title documents are available", pattern: /deed|title|ownership/i },
      { key: 'counterpartyName', label: "Full legal name of the other party", pattern: /landlord|tenant|seller|buyer/i },
    ]
  },
  employment: {
    keywords: [
      'employment', 'fired', 'termination', 'wrongful termination', 'discrimination',
      'harassment', 'workplace', 'HR', 'employer', 'employee', 'wage', 'overtime',
      'EEOC', 'hostile work environment', 'retaliation', 'laid off'
    ],
    label: 'Employment Law',
    inScope: true,
    missingChecks: [
      { key: 'employerName', label: "Full legal name of the employer", pattern: /employer|company|work/i },
      { key: 'terminationDate', label: "Date of termination or adverse action", pattern: /terminat|fired|laid off|date/i },
      { key: 'eeocFiled', label: "Whether an EEOC or state agency charge has been filed", pattern: /EEOC|charge|agency|filed/i },
    ]
  },
  criminal: {
    keywords: [
      'criminal', 'DUI', 'DWI', 'arrest', 'charges', 'felony', 'misdemeanor',
      'police', 'crime', 'assault', 'battery', 'theft', 'drug', 'narcotics',
      'indictment', 'arraignment', 'bail', 'public defender', 'plea', 'sentence',
      'conviction', 'probation', 'parole', 'defendant', 'prosecution'
    ],
    label: 'Criminal Defense',
    inScope: false,
    referralNote: 'Our firm does not handle criminal defense matters. We recommend contacting the State Bar Lawyer Referral Service for a criminal defense attorney.'
  },
  immigration: {
    keywords: [
      'immigration', 'visa', 'citizenship', 'deportation', 'green card', 'asylum',
      'USCIS', 'removal', 'work permit', 'naturalization', 'undocumented'
    ],
    label: 'Immigration',
    inScope: false,
    referralNote: 'Our firm does not handle immigration matters. We recommend contacting a Board of Immigration Appeals accredited representative or immigration attorney.'
  },
  familyLaw: {
    keywords: [
      'divorce', 'custody', 'child support', 'alimony', 'spousal support', 'separation',
      'adoption', 'domestic violence', 'restraining order', 'marital'
    ],
    label: 'Family Law',
    inScope: false,
    referralNote: 'Our firm does not currently handle family law matters. We recommend contacting the State Bar Lawyer Referral Service.'
  }
};

function classifyMatter(description, partiesInvolved = '') {
  const text = `${description} ${partiesInvolved}`.toLowerCase();
  const scores = {};

  for (const [area, config] of Object.entries(PRACTICE_AREAS)) {
    scores[area] = config.keywords.filter(kw => text.includes(kw.toLowerCase())).length;
  }

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const [topKey, topScore] = sorted[0];
  const [secondKey, secondScore] = sorted[1] || ['', 0];

  if (topScore === 0) {
    return {
      areaKey: 'unknown',
      label: 'General Inquiry / Unable to Classify',
      inScope: null,
      confidence: 0,
      needsManualReview: true
    };
  }

  const config = PRACTICE_AREAS[topKey];
  const maxPossible = config.keywords.length;
  const rawConfidence = (topScore / maxPossible) * 100;
  const margin = topScore - secondScore;
  const confidence = Math.min(97, Math.round(rawConfidence * 0.6 + margin * 5 + 45));

  return {
    areaKey: topKey,
    label: config.label,
    inScope: config.inScope,
    confidence,
    referralNote: config.referralNote || null,
    needsManualReview: confidence < 60
  };
}

function extractConflictNames(intake) {
  const names = new Set();
  const text = `${intake.firstName} ${intake.lastName} ${intake.partiesInvolved} ${intake.matterDescription}`;

  // Always include the prospective client
  names.add(`${intake.firstName} ${intake.lastName}`.trim());

  // Extract names from partiesInvolved (comma or semicolon separated)
  if (intake.partiesInvolved) {
    intake.partiesInvolved
      .split(/[,;\/\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 2 && s.length < 80)
      .forEach(name => names.add(name));
  }

  // Simple heuristic: capitalized word pairs in description not at sentence start
  const namePattern = /(?<!\.\s)(?<![A-Z][a-z]+\s)([A-Z][a-z]{1,15}\s[A-Z][a-z]{1,15}(?:\s[A-Z][a-z]{1,15})?)/g;
  let match;
  while ((match = namePattern.exec(intake.matterDescription)) !== null) {
    const candidate = match[1].trim();
    // Filter out common non-name capitalized phrases
    const skipWords = ['Estate Of', 'State Of', 'Court Of', 'City Of', 'County Of', 'United States'];
    if (!skipWords.some(w => candidate.startsWith(w))) {
      names.add(candidate);
    }
  }

  return [...names].filter(Boolean);
}

function identifyMissingInfo(intake, areaKey) {
  const missing = [];
  const description = (intake.matterDescription || '').toLowerCase();
  const area = PRACTICE_AREAS[areaKey];

  if (!area || !area.missingChecks) {
    // Generic checks
    if (!intake.phone || intake.phone.length < 7) missing.push('Callback phone number');
    if (!intake.matterDescription || intake.matterDescription.length < 50) missing.push('Detailed description of the legal matter');
    return missing;
  }

  for (const check of area.missingChecks) {
    // Check if the description seems to address this topic
    if (!check.pattern.test(description) && !check.pattern.test(intake.partiesInvolved || '')) {
      missing.push(check.label);
    }
  }

  // Universal checks
  if (!intake.phone || intake.phone.replace(/\D/g, '').length < 7) {
    missing.push('Valid callback phone number');
  }
  if (!intake.urgency) {
    missing.push('Urgency level / any pending court dates or deadlines');
  }

  return missing;
}

function assessRiskFlags(intake, areaKey) {
  const flags = [];
  const desc = (intake.matterDescription || '').toLowerCase();
  const urgency = (intake.urgency || '').toLowerCase();

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
  if (intake.estimatedDamages && parseInt(intake.estimatedDamages.replace(/\D/g, ''), 10) > 100000) {
    flags.push('High-value matter — conflicts check and insurance notification may be required');
  }

  return flags;
}

function generateAcknowledgmentEmail(intake, analysis) {
  const firstName = intake.firstName || 'there';
  const isInScope = analysis.inScope === true;
  const isOutOfScope = analysis.inScope === false;
  const firmName = 'Hargrove & Associates';
  const firmPhone = '(555) 400-2200';
  const firmEmail = 'intake@hargrovelaw.example.com';

  if (isOutOfScope) {
    return `Subject: Your Inquiry to ${firmName} — Receipt Confirmed

Dear ${firstName},

Thank you for reaching out to ${firmName}. We have received your inquiry submitted on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.

After a preliminary review, it appears that your matter may fall outside the practice areas our firm currently handles. Specifically, matters involving ${analysis.label} are not areas in which our firm currently offers representation.

${analysis.referralNote ? analysis.referralNote : 'We encourage you to contact the State Bar Lawyer Referral Service for assistance finding qualified counsel in this area.'}

IMPORTANT: This message does not constitute legal advice, and no attorney-client relationship has been formed between you and ${firmName} by virtue of this communication or your submission of this inquiry. Please do not take or refrain from taking any legal action based on this message.

If you believe your matter has been incorrectly characterized, or if you have additional questions, please contact our office at ${firmPhone} or ${firmEmail}.

We wish you the best in finding the representation you need.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
${firmName}
${firmPhone} | ${firmEmail}

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`;
  }

  const missingNote = analysis.missingInfo && analysis.missingInfo.length > 0
    ? `\nTo help us evaluate your matter as efficiently as possible, it would be helpful to have the following information ready when you speak with our office:\n\n${analysis.missingInfo.map(m => `  • ${m}`).join('\n')}\n`
    : '';

  return `Subject: Your Inquiry to ${firmName} — Receipt Confirmed

Dear ${firstName},

Thank you for contacting ${firmName}. We have received your inquiry submitted on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.

A member of our team will review your matter and be in touch within [X] business days to discuss next steps. Please note that no attorney has been assigned to your matter at this time, and no attorney-client relationship has been formed.
${missingNote}
If your matter is urgent or you have an upcoming court date or deadline, please call our office immediately at ${firmPhone} so we can prioritize your inquiry accordingly.

IMPORTANT: This acknowledgment does not constitute legal advice, and no attorney-client relationship has been formed between you and ${firmName} by virtue of this communication or your submission. The submission of this form and receipt of this message does not obligate our firm to represent you.

We appreciate your interest in our firm and look forward to speaking with you.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
${firmName}
${firmPhone} | ${firmEmail}

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING`;
}

function generateAttorneySummary(intake, analysis) {
  const submittedAt = new Date().toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const scopeTag = analysis.inScope === true ? '✅ IN SCOPE'
    : analysis.inScope === false ? '🚫 OUT OF SCOPE'
    : '⚠️ NEEDS REVIEW';

  const missingList = analysis.missingInfo && analysis.missingInfo.length > 0
    ? analysis.missingInfo.map(m => `- [ ] ${m}`).join('\n')
    : '- None identified at this stage';

  const flagList = analysis.riskFlags && analysis.riskFlags.length > 0
    ? analysis.riskFlags.map(f => `- ⚠️ ${f}`).join('\n')
    : '- None identified';

  const conflictList = analysis.conflictNames && analysis.conflictNames.length > 0
    ? analysis.conflictNames.map(n => `- ${n}`).join('\n')
    : '- None extracted';

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
| **Submitted** | ${submittedAt} |
| **Contact Email** | ${intake.email || '—'} |
| **Contact Phone** | ${intake.phone || '—'} |
| **Urgency (Self-Reported)** | ${intake.urgency || 'Not specified'} |
| **Estimated Value** | ${intake.estimatedDamages || 'Not provided'} |
| **Prior Attorney** | ${intake.priorAttorney || 'None reported'} |
| **Referral Source** | ${intake.referralSource || 'Not specified'} |

---

## Classification ${scopeTag}

- **Practice Area:** ${analysis.label}
- **Confidence:** ${analysis.confidence}%
- **In-Scope:** ${analysis.inScope === true ? 'Yes' : analysis.inScope === false ? 'No' : 'Unclear — manual review required'}
${analysis.needsManualReview ? '\n> ⚠️ **Low confidence classification — attorney should review description directly.**\n' : ''}
${analysis.referralNote ? `\n**Referral Guidance:** ${analysis.referralNote}\n` : ''}

---

## Client Description (Verbatim)

> ${(intake.matterDescription || '').split('\n').join('\n> ')}

**Parties Identified by Client:** ${intake.partiesInvolved || 'None listed'}

---

## Conflict Check Names

*The following names were extracted from the intake for conflict screening. This list may be incomplete. Attorney must conduct full conflict check before any substantive discussion.*

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

${analysis.inScope === false ? `
1. **Do not assign an attorney** — matter is outside firm's practice areas
2. Send the draft out-of-scope acknowledgment email (after attorney review)
3. Provide referral information: ${analysis.referralNote || 'State Bar Referral Service'}
4. Close intake — no further action required
` : `
1. **Run full conflicts check** using extracted names above
2. Assign intake to appropriate practice group: **${analysis.label}**
3. ${analysis.missingInfo && analysis.missingInfo.length > 0 ? 'Gather missing information (see above) during initial consultation call' : 'Schedule initial consultation call'}
4. Review and send draft acknowledgment email (after attorney approval)
5. Determine engagement letter requirements if matter is accepted
`}

---

*Generated by GuideHerd Legal Intake Copilot | ${submittedAt}*
*DRAFT — FOR ATTORNEY REVIEW ONLY — DO NOT DISTRIBUTE*`;
}

function processIntake(intake) {
  const classification = classifyMatter(intake.matterDescription, intake.partiesInvolved);
  const conflictNames = extractConflictNames(intake);
  const missingInfo = identifyMissingInfo(intake, classification.areaKey);
  const riskFlags = assessRiskFlags(intake, classification.areaKey);

  const analysis = {
    ...classification,
    conflictNames,
    missingInfo,
    riskFlags
  };

  const acknowledgmentEmail = generateAcknowledgmentEmail(intake, analysis);
  const attorneySummary = generateAttorneySummary(intake, analysis);

  return {
    analysis,
    drafts: {
      acknowledgmentEmail,
      attorneySummary
    }
  };
}

module.exports = { processIntake };
