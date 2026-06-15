#!/usr/bin/env node
/**
 * GuideHerd Legal Intake Copilot — Demo Output Validator
 *
 * Reads:   outputs/demo-processed-intakes.json
 * Checks:  All safety and compliance constraints from Output_Schema.json
 * Prints:  PASS or FAIL with details
 *
 * Uses Node.js built-in modules only.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT   = path.resolve(__dirname, '..');
const INPUT  = path.join(ROOT, 'outputs', 'demo-processed-intakes.json');

// ---------------------------------------------------------------------------
// Prohibited phrases — none of these may appear in any output field
// ---------------------------------------------------------------------------
const PROHIBITED_PHRASES = [
  'we represent you',
  'you are our client',
  'our client',
  'you should',
  'you must',
  'is guaranteed to',
  'we guarantee',
  'will win',
  'conflict cleared',
  'conflict is cleared',
  'no conflict found',
];

// ---------------------------------------------------------------------------
// Required fields per record
// ---------------------------------------------------------------------------
const REQUIRED_FIELDS = [
  'intake_id',
  'processed_at',
  'demo_data_only',
  'not_legal_advice',
  'requires_human_approval',
  'firm',
  'intake',
  'classification',
  'fit_status',
  'confidence_score',
  'urgency',
  'conflict_check_names',
  'missing_information',
  'consultation_questions',
  'internal_warnings',
  'attorney_summary',
  'client_acknowledgment',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let totalChecks = 0;
let failures    = [];

function check(label, condition, detail) {
  totalChecks++;
  if (!condition) {
    failures.push({ label, detail: detail || '(no detail)' });
    console.log(`  ✗ FAIL — ${label}`);
    if (detail) console.log(`         ${detail}`);
  } else {
    console.log(`  ✓ PASS — ${label}`);
  }
}

function checkTextForProhibited(text, fieldLabel, recordLabel) {
  const lower = (text || '').toLowerCase();
  for (const phrase of PROHIBITED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      check(
        `[${recordLabel}] Prohibited phrase in ${fieldLabel}`,
        false,
        `Found: "${phrase}"`
      );
    } else {
      check(
        `[${recordLabel}] No "${phrase}" in ${fieldLabel}`,
        true,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------
console.log('GuideHerd Legal Intake Copilot — Output Validator');
console.log('==================================================');
console.log('');

// 1. File exists
if (!fs.existsSync(INPUT)) {
  console.log(`✗ FAIL — Output file not found: ${INPUT}`);
  console.log('  Run node scripts/process-demo-intakes.js first.');
  process.exit(1);
}

let records;
try {
  records = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
} catch (e) {
  console.log(`✗ FAIL — Could not parse output file: ${e.message}`);
  process.exit(1);
}

check('Output file exists and is valid JSON', true);
check('Output contains records', Array.isArray(records) && records.length > 0,
  `Got ${Array.isArray(records) ? records.length : 'non-array'} records`);
check('Exactly 3 demo records present', records.length === 3,
  `Expected 3, got ${records.length}`);

console.log('');

// ---------------------------------------------------------------------------
// Per-record checks
// ---------------------------------------------------------------------------
records.forEach((record, i) => {
  const label = record.intake_id || `record[${i}]`;
  console.log(`--- Validating record: ${label} ---`);

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    check(
      `[${label}] Required field: ${field}`,
      record[field] !== undefined && record[field] !== null,
      `Field "${field}" is missing or null`
    );
  }

  // Hard boolean constraints
  check(`[${label}] demo_data_only === true`,
    record.demo_data_only === true, 'Must be boolean true');
  check(`[${label}] not_legal_advice === true`,
    record.not_legal_advice === true, 'Must be boolean true');
  check(`[${label}] requires_human_approval === true`,
    record.requires_human_approval === true, 'Must be boolean true');

  // fit_status enum
  check(`[${label}] fit_status is valid enum`,
    ['in_scope', 'out_of_scope', 'needs_review'].includes(record.fit_status),
    `Got: "${record.fit_status}"`);

  // urgency enum
  check(`[${label}] urgency is valid enum`,
    ['low', 'medium', 'high', 'emergency'].includes(record.urgency),
    `Got: "${record.urgency}"`);

  // confidence_score range
  check(`[${label}] confidence_score in 0–100`,
    typeof record.confidence_score === 'number' &&
    record.confidence_score >= 0 &&
    record.confidence_score <= 100,
    `Got: ${record.confidence_score}`);

  // Client acknowledgment starts with [DRAFT]
  const ack = record.client_acknowledgment || '';
  check(`[${label}] client_acknowledgment starts with [DRAFT]`,
    ack.trimStart().startsWith('[DRAFT]'),
    `First 40 chars: "${ack.trimStart().slice(0, 40)}"`);

  // Attorney summary exists and is not blank
  check(`[${label}] attorney_summary is non-empty string`,
    typeof record.attorney_summary === 'string' &&
    record.attorney_summary.trim().length > 50,
    'attorney_summary is too short or missing');

  // Attorney summary has internal label
  check(`[${label}] attorney_summary has INTERNAL label`,
    (record.attorney_summary || '').includes('INTERNAL'),
    'Expected "INTERNAL" label at top of attorney_summary');

  // Conflict check has disclaimer
  check(`[${label}] conflict_check_names.disclaimer present`,
    record.conflict_check_names &&
    typeof record.conflict_check_names.disclaimer === 'string' &&
    record.conflict_check_names.disclaimer.length > 20);

  // Conflict disclaimer does not say "conflict cleared"
  check(`[${label}] conflict disclaimer does not say "conflict cleared"`,
    !(record.conflict_check_names?.disclaimer || '').toLowerCase().includes('conflict cleared'));
  check(`[${label}] conflict disclaimer does not say "no conflict found"`,
    !(record.conflict_check_names?.disclaimer || '').toLowerCase().includes('no conflict found'));

  // Missing information is an array
  check(`[${label}] missing_information is an array`,
    Array.isArray(record.missing_information));

  // Consultation questions is a non-empty array
  check(`[${label}] consultation_questions is non-empty array`,
    Array.isArray(record.consultation_questions) &&
    record.consultation_questions.length > 0,
    `Got ${record.consultation_questions?.length} questions`);

  // Scan all text fields for prohibited phrases
  console.log(`  --- Prohibited phrase scan: ${label} ---`);
  const fieldsToScan = [
    ['attorney_summary',      record.attorney_summary],
    ['client_acknowledgment', record.client_acknowledgment],
  ];
  if (record.conflict_check_names?.disclaimer) {
    fieldsToScan.push(['conflict_check_names.disclaimer', record.conflict_check_names.disclaimer]);
  }
  (record.internal_warnings || []).forEach((w, wi) => {
    fieldsToScan.push([`internal_warnings[${wi}]`, w]);
  });
  (record.consultation_questions || []).forEach((q, qi) => {
    fieldsToScan.push([`consultation_questions[${qi}]`, q]);
  });

  for (const [fieldName, fieldText] of fieldsToScan) {
    const lower = (fieldText || '').toLowerCase();
    for (const phrase of PROHIBITED_PHRASES) {
      totalChecks++;
      if (lower.includes(phrase.toLowerCase())) {
        failures.push({
          label: `[${label}] Prohibited phrase in ${fieldName}`,
          detail: `Found: "${phrase}"`,
        });
        console.log(`  ✗ FAIL — Prohibited phrase in ${fieldName}: "${phrase}"`);
      }
      // (pass cases suppressed for prohibited phrase scan to keep output readable)
    }
  }

  console.log('');
});

// ---------------------------------------------------------------------------
// Final result
// ---------------------------------------------------------------------------
console.log('==================================================');
console.log(`Checks run: ${totalChecks}`);
console.log(`Failures:   ${failures.length}`);
console.log('');

if (failures.length === 0) {
  console.log('RESULT: ✅ PASS — All validation checks passed.');
  process.exit(0);
} else {
  console.log('RESULT: ❌ FAIL — Validation errors found:\n');
  failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.label}`);
    if (f.detail) console.log(`     ${f.detail}`);
  });
  process.exit(1);
}
