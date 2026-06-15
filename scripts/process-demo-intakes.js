const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const writeJson = (rel, data) => fs.writeFileSync(path.join(root, rel), JSON.stringify(data, null, 2) + '\n');
const writeText = (rel, data) => fs.writeFileSync(path.join(root, rel), data);

const intakePath = 'data/demo-intakes.json';
const rulesPath = 'data/classification-rules.json';
const outputsPath = 'outputs/demo-processed-intakes.json';
const fallbackDataPath = 'data/demo-processed-intakes.json';
const summariesPath = 'outputs/demo-attorney-summaries.md';
const ackTemplate = fs.readFileSync(path.join(root, 'docs/legal-intake/Client_Acknowledgment_Template.md'), 'utf8');

const intakes = readJson(intakePath);
const rulesData = readJson(rulesPath);

const ALL_OUT_OF_SCOPE = new Set([
  'criminal defense',
  'divorce',
  'custody',
  'immigration',
  'bankruptcy',
  'personal injury',
  'tax controversy',
]);

function lowerAll(values) {
  return values.map((v) => String(v).toLowerCase());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractFactsText(intake) {
  const transcript = (intake.phone_transcript || [])
    .map((turn) => `${turn.speaker}: ${turn.text}`)
    .join(' \n ');
  return [intake.potential_client, intake.matter_type, ...(intake.facts || []), transcript].join(' \n ').toLowerCase();
}

function classify(intake) {
  const text = extractFactsText(intake);
  const rules = rulesData.rules || [];
  let matched = null;

  for (const rule of rules) {
    const needles = lowerAll(rule.match_any || []);
    if (needles.some((needle) => text.includes(needle))) {
      matched = rule;
      break;
    }
  }

  let fitStatus = matched ? matched.fit_status : 'uncertain';
  let matterType = matched ? matched.matter_type : intake.matter_type;
  let urgency = matched ? matched.urgency_default : 'low';

  const escalators = (rulesData.urgency_escalators || []).map((s) => s.toLowerCase());
  const hasEscalator = escalators.some((phrase) => text.includes(phrase));
  if (hasEscalator) urgency = 'high';

  if (text.includes('arrest') || text.includes('hearing') || text.includes('deadline') || text.includes('emergency') || text.includes('imminent loss of rights')) {
    urgency = 'high';
  }

  if (intake.matter_type.toLowerCase().includes('criminal')) {
    fitStatus = 'refer_out';
    matterType = 'Criminal defense';
    urgency = 'high';
  }

  if (text.includes('guardianship') || text.includes('trust') || text.includes('deed') || text.includes('house sale')) {
    matterType = 'Probate / trust / property dispute';
  } else if (text.includes('probate') || text.includes('estate')) {
    matterType = 'Probate / estate dispute';
  } else if (text.includes('invoice') || text.includes('payment dispute') || text.includes('contract')) {
    matterType = 'Small business unpaid invoice';
  }

  return { fitStatus, matterType, urgency };
}

function extractConflictCheck(intake) {
  const named = intake.named_entities || {};
  return {
    potential_client: unique([intake.potential_client]),
    opposing_parties: unique(named.opposing_parties || []),
    related_entities: unique(named.related_entities || []),
    deceased_persons: unique(named.deceased_persons || []),
    heirs_or_beneficiaries: unique(named.heirs_or_beneficiaries || []),
    witnesses_or_other_names: unique(named.witnesses_or_other_names || []),
    opposing_counsel: unique(named.opposing_counsel || []),
  };
}

function missingInfoFor(intake) {
  const text = extractFactsText(intake);
  const missing = [];

  if (text.includes('probate') || text.includes('estate') || text.includes('will')) {
    missing.push('Whether a will exists', 'Whether a probate case has already been filed', 'Court and case number', 'Executor or personal representative name');
  }
  if (text.includes('guardianship') || text.includes('trust') || text.includes('deed') || text.includes('house sale')) {
    missing.push('Whether an emergency guardianship or injunction filing has already been made', 'County and court where the matter is pending', 'Copy of the deed, trust, or other ownership document', 'Names of any other family members or parties involved');
  }
  if (text.includes('invoice') || text.includes('payment dispute') || text.includes('contract')) {
    missing.push('Underlying contract or work order reference', 'Whether a demand letter was sent', 'Whether any payment plan was offered', 'Any prior disputes on the account');
  }
  if (text.includes('criminal') || text.includes('arrest')) {
    missing.push('Case number', 'Exact court date and time', 'Whether the client has retained criminal counsel already');
  }

  return unique(missing);
}

function consultationQuestionsFor(intake, fitStatus) {
  const text = extractFactsText(intake);
  if (fitStatus === 'refer_out') return [];
  if (text.includes('guardianship') || text.includes('trust') || text.includes('deed') || text.includes('house sale')) {
    return [
      'Has anyone already filed an emergency guardianship or injunction request?',
      'Which county and court are handling the matter?',
      'Who currently controls the property, trust, or account at issue?',
      'What deadlines, hearings, or closing dates are already scheduled?',
    ];
  }
  if (text.includes('probate') || text.includes('estate')) {
    return [
      'Has a probate case been filed already?',
      'Who is serving as executor or personal representative?',
      'What court and case number are involved?',
      'Are any deadlines already pending?',
    ];
  }
  if (text.includes('invoice') || text.includes('payment dispute') || text.includes('contract')) {
    return [
      'What contract or work order governs the job?',
      'Has a written demand been sent?',
      'What payment terms were agreed to?',
      'Has the other side disputed the invoice amount?',
    ];
  }
  return [
    'What is the basic timeline?',
    'What documents or dates are most important?',
    'Is there any deadline or hearing already set?',
  ];
}

function summaryForAttorney(intake, fitStatus, urgency) {
  const named = intake.named_entities || {};
  const text = extractFactsText(intake);
  if (text.includes('guardianship') || text.includes('trust') || text.includes('deed') || text.includes('house sale')) {
    return `Complex family estate / guardianship dispute involving ${(named.deceased_persons || ['a deceased person'])[0] || 'a deceased family member'}, a disputed property or trust issue, and multiple family members.`;
  }
  if (intake.matter_type.toLowerCase().includes('probate') || intake.facts.join(' ').toLowerCase().includes('probate')) {
    return `Potential probate / estate dispute involving the death of ${(named.deceased_persons || ['a deceased family member'])[0]}, a sibling challenge, and a pending probate deadline.`;
  }
  if (intake.facts.join(' ').toLowerCase().includes('invoice') || intake.facts.join(' ').toLowerCase().includes('payment dispute')) {
    return `Commercial invoice dispute involving ${intake.potential_client} and ${(named.opposing_parties || ['an opposing business'])[0]}. The unpaid invoice appears overdue.`;
  }
  if (fitStatus === 'refer_out') {
    return `Out-of-scope criminal defense request with arrest and hearing facts. This should be referred out immediately.`;
  }
  return `Demo intake for ${intake.matter_type} with urgency ${urgency}.`;
}

function recommendedNextAction(fitStatus) {
  if (fitStatus === 'refer_out') {
    return 'DRAFT: mark out of scope, escalate to a human immediately, and prepare a non-committal referral response if needed.';
  }
  return 'DRAFT: route to human review, confirm fit/conflicts, and prepare a non-advisory acknowledgment.';
}

function clientAckDraft() {
  const body = [
    'Thank you for contacting Madison Valley Law Group.',
    'We received your intake submission and are reviewing it for fit and conflict screening. This message is administrative only and does not mean we represent you.',
    'Please do not send sensitive documents unless we specifically ask for them in a human-approved follow-up.',
    'This is a DRAFT message and requires human approval before use.',
  ].join(' ');
  return {
    subject: 'DRAFT — We received your intake form',
    body,
  };
}

function phoneIntakeCapture(intake, matterType, fitStatus, urgency, summary, conflictCheck) {
  const transcript = intake.phone_transcript || [];
  return {
    source_channel: intake.source_channel || 'web',
    voice_provider: intake.voice_provider || null,
    call_type: intake.source_channel === 'phone' ? 'voice call' : 'web form',
    caller_name: intake.potential_client,
    matter_type: matterType,
    fit_status: fitStatus,
    urgency,
    summary_for_staff: summary,
    key_people: unique([
      intake.potential_client,
      ...(conflictCheck.opposing_parties || []),
      ...(conflictCheck.related_entities || []),
      ...(conflictCheck.deceased_persons || []),
    ]),
    transcript,
  };
}

function internalWarnings(intake, fitStatus, urgency) {
  const warnings = ['Conflict names extracted only; no conflict decision made', 'DRAFT client communication only'];
  const text = extractFactsText(intake);
  if (text.includes('probate') || text.includes('deadline')) warnings.unshift('Probate deadline mentioned');
  if (text.includes('guardianship') || text.includes('trust') || text.includes('deed') || text.includes('house sale')) warnings.unshift('Multiple estate / guardianship facts mentioned');
  if (text.includes('arrest')) warnings.unshift('Arrest and next-day hearing mentioned');
  if ((intake.phone_transcript || []).length) warnings.unshift('Normalized from phone transcript');
  if (fitStatus === 'refer_out') warnings.unshift('Out of scope: criminal defense');
  if (urgency === 'high') warnings.push('Human review recommended immediately');
  return unique(warnings);
}

function buildProcessed(intake) {
  const { fitStatus, matterType, urgency } = classify(intake);
  const conflict_check = extractConflictCheck(intake);
  const missing_information = missingInfoFor(intake);
  const consultation_questions = consultationQuestionsFor(intake, fitStatus);
  const summary = summaryForAttorney(intake, fitStatus, urgency);
  const client_acknowledgment_draft = clientAckDraft();
  const phone_intake_capture = phoneIntakeCapture(intake, matterType, fitStatus, urgency, summary, conflict_check);

  let urgencyReason = 'No urgent facts were provided.';
  const text = extractFactsText(intake);
  if (text.includes('probate') || text.includes('deadline')) urgencyReason = 'Probate court deadline was mentioned, so the matter needs prompt human review.';
  if (text.includes('guardianship') || text.includes('trust') || text.includes('deed') || text.includes('house sale')) urgencyReason = 'Multiple family and property issues were mentioned, so this needs prompt human review.';
  if (text.includes('invoice') || text.includes('payment dispute')) urgencyReason = 'A business payment dispute is in scope, but no emergency facts were provided.';
  if (text.includes('arrest')) urgencyReason = 'An arrest and next-day hearing were mentioned, so this should be escalated immediately.';

  return {
    lead_id: intake.lead_id,
    submitted_at: intake.submitted_at,
    potential_client: intake.potential_client,
    matter_type: matterType,
    fit_status: fitStatus,
    urgency,
    urgency_reason: urgencyReason,
    summary_for_attorney: summary,
    conflict_check,
    missing_information,
    recommended_next_action: recommendedNextAction(fitStatus),
    consultation_questions,
    client_acknowledgment_draft,
    source_channel: intake.source_channel || 'web',
    voice_provider: intake.voice_provider || null,
    phone_intake_capture,
    internal_warnings: internalWarnings(intake, fitStatus, urgency),
    not_legal_advice: true,
    requires_human_approval: true,
  };
}

const processed = intakes.map(buildProcessed);
writeJson(outputsPath, processed);
writeJson(fallbackDataPath, processed);

const summaryLines = ['# Demo Attorney Summaries', ''];
for (const item of processed) {
  summaryLines.push(`## ${item.lead_id} — ${item.potential_client}`);
  summaryLines.push(`- Matter: ${item.matter_type}`);
  summaryLines.push(`- Fit: ${item.fit_status}`);
  summaryLines.push(`- Urgency: ${item.urgency}`);
  summaryLines.push(`- Note: ${item.summary_for_attorney}`);
  summaryLines.push('');
}
writeText(summariesPath, summaryLines.join('\n'));

console.log(`Processed ${processed.length} demo intakes.`);
console.log(`Wrote ${outputsPath}`);
console.log(`Wrote ${fallbackDataPath}`);
console.log(`Wrote ${summariesPath}`);
