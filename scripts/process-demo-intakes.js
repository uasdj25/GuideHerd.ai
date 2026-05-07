#!/usr/bin/env node
/**
 * GuideHerd Legal Intake Copilot — Demo Intake Processor
 *
 * Reads:  data/demo-intakes.json
 * Writes: outputs/demo-processed-intakes.json
 *         outputs/demo-attorney-summaries.md
 *         data/demo-processed-intakes.json   (browser-safe copy)
 *
 * Uses Node.js built-in modules only (fs, path).
 * No external APIs. No network requests. No real data.
 * All output is fictional demo data only.
 *
 * IMPORTANT: This script does not provide legal advice, conduct conflict
 * checks, create attorney-client relationships, or send communications.
 * All output requires attorney review before any action is taken.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT        = path.resolve(__dirname, '..');
const INPUT       = path.join(ROOT, 'data',    'demo-intakes.json');
const OUT_JSON    = path.join(ROOT, 'outputs', 'demo-processed-intakes.json');
const OUT_MD      = path.join(ROOT, 'outputs', 'demo-attorney-summaries.md');
const BROWSER_JSON= path.join(ROOT, 'data',    'demo-processed-intakes.json');

// Ensure outputs/ directory exists
const outDir = path.join(ROOT, 'outputs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Firm config (fictional)
// ---------------------------------------------------------------------------
const FIRM = {
  name:     'Madison Valley Law Group',
  location: 'Madison, Alabama',
  phone:    '256-555-0199',
  email:    'intake@madisonvalleylaw.example',
};

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------
const PRACTICE_AREAS = [
  {
    name: 'Probate',
    keywords: ['probate','executor','executrix','estate','decedent','intestate',
               'will contest','inheritance','administrator','beneficiary',
               'passed away','died','death','letters testamentary'],
    in_scope: true,
  },
  {
    name: 'Estate Planning',
    keywords: ['will','trust','estate plan','power of attorney','healthcare directive',
               'advance directive','living will','revocable trust','irrevocable'],
    in_scope: true,
  },
  {
    name: 'Small Business Disputes',
    keywords: ['invoice','unpaid','breach','contract dispute','partnership dispute',
               'vendor','business dispute','llc','demand letter','collection',
               'landscaping','services rendered','payment','commercial'],
    in_scope: true,
  },
  {
    name: 'Contract Review',
    keywords: ['contract review','agreement review','nda','non-disclosure',
               'terms of service','service agreement','lease review'],
    in_scope: true,
  },
  {
    name: 'Real Estate Transactions',
    keywords: ['real estate','property','closing','title','deed','boundary',
               'easement','purchase agreement','sale agreement','land'],
    in_scope: true,
  },
  {
    name: 'Out of Scope — Criminal Defense',
    keywords: ['dui','dwi','criminal','arrested','arraignment','charge','felony',
               'misdemeanor','bail','bond','indictment','prosecution'],
    in_scope: false,
    referral_suggestion: 'Criminal defense matters are outside this firm\'s practice. The prospective client should consult a licensed criminal defense attorney in the relevant jurisdiction as soon as possible, particularly given any pending court dates.',
  },
  {
    name: 'Out of Scope — Family Law',
    keywords: ['divorce','custody','child support','alimony','separation','adoption'],
    in_scope: false,
    referral_suggestion: 'Family law matters are outside this firm\'s practice. The prospective client should consult a licensed family law attorney.',
  },
  {
    name: 'Out of Scope — Personal Injury',
    keywords: ['personal injury','car accident','auto accident','slip and fall',
               'medical malpractice','negligence','tort'],
    in_scope: false,
    referral_suggestion: 'Personal injury matters are outside this firm\'s practice. The prospective client should consult a licensed personal injury attorney.',
  },
  {
    name: 'Out of Scope — Bankruptcy',
    keywords: ['bankruptcy','chapter 7','chapter 13','debt discharge','creditor'],
    in_scope: false,
    referral_suggestion: 'Bankruptcy matters are outside this firm\'s practice. The prospective client should consult a licensed bankruptcy attorney.',
  },
  {
    name: 'Out of Scope — Immigration',
    keywords: ['immigration','visa','citizenship','deportation','asylum','green card'],
    in_scope: false,
    referral_suggestion: 'Immigration matters are outside this firm\'s practice. The prospective client should consult a licensed immigration attorney.',
  },
];

// ---------------------------------------------------------------------------
// Step 1 — Classify matter
// ---------------------------------------------------------------------------
function classifyMatter(intake) {
  const text = (
    (intake.matter_description || '') + ' ' +
    (intake.parties_involved    || '') + ' ' +
    (intake.urgency_self_reported || '')
  ).toLowerCase();

  const scores = PRACTICE_AREAS.map(area => {
    const hits = area.keywords.filter(kw => text.includes(kw));
    return { area, hits, score: hits.length };
  });

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (best.score === 0) {
    return {
      classification:    'Needs Review',
      fit_status:        'needs_review',
      confidence_score:  20,
      secondary_areas:   [],
      referral_suggestion: null,
    };
  }

  // Collect secondary areas (in-scope only, score > 0, not the winner)
  const secondary = scores
    .filter(s => s.area !== best.area && s.score > 0 && s.area.in_scope)
    .map(s => s.area.name);

  const confidence = Math.min(95, 40 + best.score * 12);

  return {
    classification:     best.area.name,
    fit_status:         best.area.in_scope ? 'in_scope' : 'out_of_scope',
    confidence_score:   confidence,
    secondary_areas:    secondary,
    referral_suggestion: best.area.referral_suggestion || null,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Assess urgency
// ---------------------------------------------------------------------------
function assessUrgency(intake) {
  const text = (
    (intake.matter_description   || '') + ' ' +
    (intake.urgency_self_reported || '')
  ).toLowerCase();

  const EMERGENCY_TRIGGERS = ['emergency','arraignment','court date','hearing','filing deadline','tomorrow','today'];
  const HIGH_TRIGGERS       = ['demand letter','statute of limitations','deadline','next week','days'];
  const MEDIUM_TRIGGERS     = ['dispute','collection','demand','follow-up','overdue'];

  if (EMERGENCY_TRIGGERS.some(t => text.includes(t))) return 'emergency';
  if (HIGH_TRIGGERS.some(t => text.includes(t)))      return 'high';
  if (MEDIUM_TRIGGERS.some(t => text.includes(t)))    return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Step 3 — Extract conflict-check names
// ---------------------------------------------------------------------------
const CONFLICT_DISCLAIMER =
  'This name list is extracted for conflict-screening purposes only. ' +
  'It may be incomplete or inaccurate. An attorney must conduct a full ' +
  'conflict-of-interest review using the firm\'s client database before any ' +
  'substantive discussion occurs. This output does not represent a conflict clearance.';

function extractConflictNames(intake) {
  const extracted = [];

  // Client
  const fullName = `${intake.first_name} ${intake.last_name}`.trim();
  if (fullName) extracted.push({ name: fullName, role: 'client' });

  // Parse parties_involved field
  const partiesRaw = intake.parties_involved || '';
  // Split on comma or semicolon
  const parts = partiesRaw.split(/[,;]/).map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    const lower = part.toLowerCase();

    // Skip the client — already added
    if (lower.includes(intake.first_name.toLowerCase()) &&
        lower.includes(intake.last_name.toLowerCase())) continue;

    // Detect role
    let role = 'referenced_third_party';
    if (/opposing party|adverse|plaintiff|defendant|respondent|creditor/i.test(part)) {
      role = 'opposing_party';
    } else if (/llc|inc\.|corp\.|company|group|properties|enterprises|services/i.test(part)) {
      role = 'entity';
    } else if (/estate of/i.test(part)) {
      role = 'entity';
    } else if (/\(opposing\)/i.test(part)) {
      role = 'opposing_party';
    }

    // Clean annotation tags like "(decedent)", "(opposing party)" etc.
    const cleanName = part.replace(/\(.*?\)/g, '').trim();
    if (cleanName && cleanName.length > 2) {
      extracted.push({ name: cleanName, role });
    }
  }

  return { extracted, disclaimer: CONFLICT_DISCLAIMER };
}

// ---------------------------------------------------------------------------
// Step 4 — Identify missing information
// ---------------------------------------------------------------------------
function identifyMissingInfo(intake, classification) {
  const missing = [];

  if (!intake.phone) missing.push('Phone number not provided — needed for scheduling consultation.');
  if (!intake.parties_involved || intake.parties_involved.trim().length < 5)
    missing.push('Opposing party names not clearly identified — needed for conflict screening.');
  if (!intake.prior_attorney || intake.prior_attorney.toLowerCase() === 'none')
    missing.push('Confirm whether prior counsel was involved on this specific matter.');

  const text = (intake.matter_description || '').toLowerCase();

  if (classification.fit_status === 'in_scope') {
    if (classification.classification.includes('Probate')) {
      if (!text.includes('date') && !text.includes('passed') && !text.includes('march') && !text.includes('april'))
        missing.push('Date of death not clearly stated.');
      if (!text.includes('court') && !text.includes('filed') && !text.includes('probate'))
        missing.push('Confirm whether probate has been opened and in which county.');
      missing.push('Copy of the will and any codicils needed for review.');
      missing.push('Inventory or estimate of all estate assets and liabilities.');
    }
    if (classification.classification.includes('Small Business')) {
      missing.push('Copy of the written contract referenced.');
      missing.push('Invoice number(s) and invoice date(s).');
      missing.push('Records of all communications regarding non-payment.');
      if (!text.includes('demand'))
        missing.push('Confirm whether a formal written demand for payment has been sent.');
    }
    if (classification.classification.includes('Real Estate')) {
      missing.push('Property address and parcel ID.');
      missing.push('Copy of purchase agreement or title report if available.');
    }
    if (classification.classification.includes('Contract')) {
      missing.push('Copy of the contract or agreement in question.');
      missing.push('Identify the specific provisions in dispute.');
    }
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Step 5 — Consultation questions
// ---------------------------------------------------------------------------
function buildConsultationQuestions(intake, classification) {
  const questions = [
    'Can you walk me through the timeline of events from beginning to today?',
    'Have you been contacted by any other attorney about this matter?',
    'Have you signed any documents related to this matter that we should review?',
  ];

  if (classification.classification.includes('Probate')) {
    questions.push('Has the will been filed with the probate court? Which county?');
    questions.push('What is your sister\'s specific basis for contesting the will — capacity, undue influence, or both?');
    questions.push('Are there any other potential beneficiaries or interested parties beyond those mentioned?');
    questions.push('Has any asset been transferred or distributed since the date of death?');
  }

  if (classification.classification.includes('Small Business')) {
    questions.push('Does the contract include a payment dispute resolution clause or arbitration provision?');
    questions.push('Has the other party given any written reason for non-payment?');
    questions.push('What is the nature of the business relationship — is this a one-time project or ongoing?');
    questions.push('Are you seeking payment only, or also damages for breach of contract?');
  }

  if (classification.classification.includes('Out of Scope')) {
    questions.push('NOTE TO ATTORNEY: Matter appears out of scope. Confirm and prepare referral information.');
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Step 6 — Internal warnings
// ---------------------------------------------------------------------------
function buildInternalWarnings(intake, classification, urgency) {
  const warnings = [];

  if (urgency === 'emergency') {
    warnings.push('URGENT: Prospective client reports an imminent court date or deadline. Confirm date and prioritize review.');
  }
  if (urgency === 'high') {
    warnings.push('HIGH URGENCY: Demand letter or time-sensitive trigger mentioned. Verify applicable deadlines.');
  }
  if (classification.fit_status === 'out_of_scope') {
    warnings.push('OUT OF SCOPE: This matter does not fall within firm practice areas. Prepare referral language. Do not discuss merits.');
  }
  if (classification.confidence_score < 50) {
    warnings.push('LOW CONFIDENCE: Classification is uncertain. Attorney should review the full description before any determination.');
  }
  const val = (intake.estimated_value || '').replace(/[^0-9]/g, '');
  if (val && parseInt(val, 10) > 100000) {
    warnings.push('HIGH VALUE: Estimated value exceeds $100,000. Senior attorney review recommended before accepting engagement.');
  }
  if (intake.prior_attorney && intake.prior_attorney.toLowerCase() !== 'none') {
    warnings.push('PRIOR COUNSEL: Prospective client mentions prior attorney. Check for potential fee disputes or malpractice exposure.');
  }
  if ((intake.matter_description || '').toLowerCase().includes('demand letter')) {
    warnings.push('DEMAND LETTER: Active demand mentioned — potential for imminent litigation.');
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Step 7 — Attorney summary
// ---------------------------------------------------------------------------
function generateAttorneySummary(intake, result) {
  const clientName = `${intake.first_name} ${intake.last_name}`;
  const date = new Date(intake.submitted_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const lines = [
    `INTERNAL — ATTORNEY EYES ONLY — NOT FOR CLIENT DISTRIBUTION`,
    ``,
    `# Intake Summary: ${clientName}`,
    `**Intake ID:** ${result.intake_id}`,
    `**Submitted:** ${date}`,
    `**Classification:** ${result.classification} (${result.confidence_score}% confidence)`,
    `**Fit Status:** ${result.fit_status.replace('_', ' ').toUpperCase()}`,
    `**Urgency:** ${result.urgency.toUpperCase()}`,
    ``,
    `---`,
    ``,
    `## What the Prospective Client Says`,
    ``,
    intake.matter_description,
    ``,
    `---`,
    ``,
    `## Classification Rationale`,
    ``,
    `The matter description appears to involve ${result.classification}. ` +
    `The classification is based on keyword and context analysis of the intake form. ` +
    `Confidence score: ${result.confidence_score}/100.`,
  ];

  if (result.secondary_areas && result.secondary_areas.length > 0) {
    lines.push(`Secondary areas potentially implicated: ${result.secondary_areas.join(', ')}.`);
  }

  if (result.fit_status === 'out_of_scope') {
    lines.push(``, `**This matter appears to be out of scope for this firm.** See referral suggestion below.`);
    if (result.referral_suggestion) {
      lines.push(``, `### Referral Note`, ``, result.referral_suggestion);
    }
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## Missing Information`,
    ``,
    ...(result.missing_information.length > 0
      ? result.missing_information.map(m => `- ${m}`)
      : ['- No significant gaps identified.']),
    ``,
    `---`,
    ``,
    `## Conflict-Check Names`,
    ``,
    `*${result.conflict_check_names.disclaimer}*`,
    ``,
    ...result.conflict_check_names.extracted.map(e => `- **${e.name}** (${e.role})`),
    ``,
    `---`,
    ``,
    `## Suggested Consultation Questions`,
    ``,
    ...result.consultation_questions.map(q => `- ${q}`),
    ``,
    `---`,
    ``,
    `## Internal Warnings`,
    ``,
    ...(result.internal_warnings.length > 0
      ? result.internal_warnings.map(w => `- ⚠️ ${w}`)
      : ['- No flags.']),
    ``,
    `---`,
    ``,
    `*This summary is a draft prepared by AI-assisted intake processing. ` +
    `It does not constitute legal advice and requires attorney review before any action is taken. ` +
    `No attorney-client relationship has been formed.*`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Step 8 — Client acknowledgment draft
// ---------------------------------------------------------------------------
function generateClientAcknowledgment(intake, result) {
  const firstName = intake.first_name;
  let matterRef = 'your recent inquiry';

  if (result.classification.includes('Probate')) {
    matterRef = 'an estate administration matter';
  } else if (result.classification.includes('Small Business')) {
    matterRef = 'a business dispute matter';
  } else if (result.classification.includes('Estate Planning')) {
    matterRef = 'an estate planning matter';
  } else if (result.classification.includes('Contract')) {
    matterRef = 'a contract matter';
  } else if (result.classification.includes('Real Estate')) {
    matterRef = 'a real estate matter';
  } else if (result.fit_status === 'out_of_scope') {
    matterRef = 'your recent inquiry';
  }

  const outOfScopeNote = result.fit_status === 'out_of_scope'
    ? `\nAfter reviewing your inquiry, it appears that this matter may fall outside of our firm's current practice areas. ` +
      `An attorney will follow up with more information, including possible referral resources that may be able to assist you.\n`
    : '';

  return [
    `[DRAFT] — Requires attorney review and approval before sending. Do not send as-is.`,
    ``,
    `Subject: We Received Your Inquiry — Madison Valley Law Group`,
    ``,
    `Dear ${firstName},`,
    ``,
    `Thank you for reaching out to Madison Valley Law Group. We have received your inquiry regarding ${matterRef}.`,
    `${outOfScopeNote}`,
    `An attorney will review the information you have provided. If your matter falls within our practice areas and no conflicts are identified, we will be in touch to schedule an initial consultation.`,
    ``,
    `Please note the following:`,
    ``,
    `- This acknowledgment does not create an attorney-client relationship.`,
    `- Submitting an inquiry does not mean the firm has agreed to represent you.`,
    `- Before any attorney-client relationship can be formed, the firm must complete a conflict-of-interest review and both parties must sign a written engagement agreement.`,
    `- No legal advice is provided by this communication.`,
    ``,
    `If your matter is time-sensitive, please call our office directly at ${FIRM.phone}.`,
    ``,
    `We appreciate you contacting our firm and will follow up as soon as possible.`,
    ``,
    `Warm regards,`,
    ``,
    `[Attorney Name — to be completed by reviewing attorney]`,
    `Madison Valley Law Group`,
    `${FIRM.phone}`,
    `${FIRM.email}`,
    ``,
    `---`,
    `IMPORTANT NOTICE: This communication is for informational purposes only and does not constitute ` +
    `legal advice. No attorney-client relationship is created by this message or by submitting an ` +
    `intake inquiry. Confidentiality of this communication cannot be assured until a formal ` +
    `engagement agreement is signed by both parties.`,
    ``,
    `[END DRAFT]`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------
function processIntake(intake) {
  const classification = classifyMatter(intake);
  const urgency        = assessUrgency(intake);
  const conflictNames  = extractConflictNames(intake);
  const missingInfo    = identifyMissingInfo(intake, classification);
  const consultQ       = buildConsultationQuestions(intake, classification);
  const warnings       = buildInternalWarnings(intake, classification, urgency);

  const record = {
    intake_id:               intake.id,
    processed_at:            new Date().toISOString(),
    demo_data_only:          true,
    not_legal_advice:        true,
    requires_human_approval: true,
    firm:                    FIRM,
    intake: {
      first_name:            intake.first_name,
      last_name:             intake.last_name,
      email:                 intake.email,
      phone:                 intake.phone || null,
      matter_description:    intake.matter_description,
      parties_involved:      intake.parties_involved || null,
      estimated_value:       intake.estimated_value || null,
      urgency_self_reported: intake.urgency_self_reported || null,
      prior_attorney:        intake.prior_attorney || null,
      referral_source:       intake.referral_source || null,
      submitted_at:          intake.submitted_at,
    },
    classification:          classification.classification,
    secondary_areas:         classification.secondary_areas,
    fit_status:              classification.fit_status,
    confidence_score:        classification.confidence_score,
    urgency:                 urgency,
    referral_suggestion:     classification.referral_suggestion || null,
    conflict_check_names:    conflictNames,
    missing_information:     missingInfo,
    consultation_questions:  consultQ,
    internal_warnings:       warnings,
  };

  // Generate text drafts
  record.attorney_summary      = generateAttorneySummary(intake, record);
  record.client_acknowledgment = generateClientAcknowledgment(intake, record);

  return record;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('GuideHerd Legal Intake Copilot — Demo Processor');
console.log('================================================');
console.log('NOTE: Processing fictional demo data only. No real client data.');
console.log('');

const intakes = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
console.log(`Read ${intakes.length} demo intake(s) from ${INPUT}`);

const results = intakes.map((intake, i) => {
  console.log(`  Processing [${i + 1}/${intakes.length}]: ${intake.first_name} ${intake.last_name} (${intake.id})`);
  return processIntake(intake);
});

// Write full output JSON
fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
console.log(`\nWrote: ${OUT_JSON}`);

// Write browser-safe copy
fs.writeFileSync(BROWSER_JSON, JSON.stringify(results, null, 2));
console.log(`Wrote: ${BROWSER_JSON}`);

// Write attorney summaries markdown
const mdParts = [
  `# GuideHerd Legal Intake Copilot — Attorney Summaries`,
  ``,
  `> **Demo document.** All data is fictional. Generated: ${new Date().toISOString()}`,
  ``,
  `---`,
  ``,
];
results.forEach(r => {
  mdParts.push(r.attorney_summary);
  mdParts.push(`\n---\n`);
});
fs.writeFileSync(OUT_MD, mdParts.join('\n'));
console.log(`Wrote: ${OUT_MD}`);

console.log(`\nDone. Run node scripts/validate-demo-outputs.js to verify outputs.`);
