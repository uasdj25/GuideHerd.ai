const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const schema = readJson('docs/legal-intake/Output_Schema.json');
const outputs = readJson('outputs/demo-processed-intakes.json');

let ok = true;
const report = [];

function fail(msg) {
  ok = false;
  report.push(`FAIL: ${msg}`);
}

function pass(msg) {
  report.push(`PASS: ${msg}`);
}

function checkRequired(obj, schemaNode, prefix = '') {
  if (!schemaNode || !schemaNode.required) return;
  for (const key of schemaNode.required) {
    if (!(key in obj)) {
      fail(`${prefix}${key} is missing`);
      continue;
    }
    const value = obj[key];
    const propSchema = schemaNode.properties ? schemaNode.properties[key] : null;
    if (propSchema && propSchema.const !== undefined && value !== propSchema.const) {
      fail(`${prefix}${key} must equal ${JSON.stringify(propSchema.const)}`);
    }
    if (key === 'conflict_check' || key === 'client_acknowledgment_draft') {
      checkRequired(value, propSchema, `${prefix}${key}.`);
    }
  }
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function containsBannedText(value) {
  const strings = collectStrings(value).map((s) => s.toLowerCase());
  const joined = strings.join(' \n ');
  if (joined.includes('legal advice')) return true;
  if (joined.includes('the firm represents you')) return true;
  if (joined.includes('represents the person')) return true;
  if (joined.includes('we represent you') && !joined.includes('does not mean we represent you')) return true;
  return false;
}

function hasDraftLanguage(item) {
  const ack = item.client_acknowledgment_draft || {};
  return /draft/i.test(ack.subject || '') || /draft/i.test(ack.body || '');
}

for (const item of outputs) {
  checkRequired(item, schema, `${item.lead_id}.`);

  if (item.not_legal_advice === true) pass(`${item.lead_id}: not_legal_advice is true`); else fail(`${item.lead_id}: not_legal_advice is not true`);
  if (item.requires_human_approval === true) pass(`${item.lead_id}: requires_human_approval is true`); else fail(`${item.lead_id}: requires_human_approval is not true`);
  if (hasDraftLanguage(item)) pass(`${item.lead_id}: client acknowledgment contains DRAFT language`); else fail(`${item.lead_id}: client acknowledgment missing DRAFT language`);
  if (containsBannedText(item)) fail(`${item.lead_id}: contains banned representation or legal-advice language`); else pass(`${item.lead_id}: no banned representation or legal-advice language found`);
}

if (ok) {
  pass('All outputs passed validation');
} else {
  fail('One or more validation checks failed');
}

console.log(report.join('\n'));
process.exit(ok ? 0 : 1);
