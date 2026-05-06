const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { processIntake } = require('./processor');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data', 'leads.json');

app.use(cors());
app.use(express.json());

// --- Data helpers ---

function readLeads() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeLeads(leads) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
}

function saveLeadOutput(lead) {
  const outputDir = path.join(__dirname, '..', 'outputs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // JSON output
  fs.writeFileSync(
    path.join(outputDir, `${lead.id}.json`),
    JSON.stringify(lead, null, 2)
  );

  // Markdown attorney summary
  if (lead.drafts?.attorneySummary) {
    fs.writeFileSync(
      path.join(outputDir, `${lead.id}_attorney_summary.md`),
      lead.drafts.attorneySummary
    );
  }
}

// --- Sample data loader ---

function loadSampleData() {
  const leads = readLeads();
  if (leads.length > 0) return;

  const samples = [
    {
      firstName: 'Margaret',
      lastName: 'Chen',
      email: 'margaret.chen@example.com',
      phone: '(555) 214-8830',
      matterDescription: `My mother, Dorothy Chen, passed away three months ago. She had a will that left her estate equally between me and my brother, Kevin Chen. The estate includes her home in Riverside County (valued around $480,000), a brokerage account, and some personal property. Kevin is now claiming that our mother signed a second, handwritten will two weeks before she died that leaves everything to him. He says she was of sound mind, but I have serious doubts — she had been in hospice care and was heavily medicated. The original will was drafted by attorney James Whitfield five years ago. I need to know if I can contest this second document and what the probate process looks like. No court proceedings have started yet.`,
      partiesInvolved: 'Dorothy Chen (deceased), Kevin Chen (brother), James Whitfield (prior attorney)',
      estimatedDamages: '$480,000+',
      priorAttorney: 'James Whitfield (drafted original will, not representing me)',
      urgency: 'Medium',
      referralSource: 'Google Search'
    },
    {
      firstName: 'Antonio',
      lastName: 'Rosario',
      email: 'tony@rosarioscapes.example.com',
      phone: '(555) 309-7741',
      matterDescription: `I own a landscaping company, Rosario Landscapes LLC. Earlier this year I entered into a written contract with Pinnacle Property Group LLC to provide commercial landscaping services for a 12-month period across three of their properties in the metro area. Total contract value was $47,500. I performed all the work as specified. They paid the first two invoices ($15,000 total) but have not paid the remaining $32,500 despite three invoices and several emails. My last communication with their office manager was six weeks ago — they said the check was "processing" and I've heard nothing since. I sent a formal demand letter via certified mail two weeks ago and have not received a response. I have the signed contract, all invoices, delivery confirmations, and the certified mail receipt. I want to sue if they don't pay. Should I file in small claims or regular court?`,
      partiesInvolved: 'Pinnacle Property Group LLC',
      estimatedDamages: '$32,500',
      priorAttorney: 'None',
      urgency: 'Medium',
      referralSource: 'Chamber of Commerce referral'
    },
    {
      firstName: 'Derek',
      lastName: 'Wilson',
      email: 'derek.wilson77@example.com',
      phone: '(555) 887-0023',
      matterDescription: `I was arrested last Saturday night for DUI. The officer said my BAC was 0.12. This is my first offense. I was driving home from a work event. I'm really worried about losing my license and what this means for my job — I drive for work. The arraignment is scheduled for next Thursday. I don't know if I need a private attorney or if I should use the public defender. I've never been in trouble before and I just want this to go away as quietly as possible.`,
      partiesInvolved: 'State v. Derek Wilson',
      estimatedDamages: 'N/A',
      priorAttorney: 'None',
      urgency: 'High',
      referralSource: 'Friend recommendation'
    }
  ];

  const seededLeads = samples.map(intake => {
    const { analysis, drafts } = processIntake(intake);
    const lead = {
      id: uuidv4(),
      submittedAt: new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
      intake,
      analysis,
      drafts
    };
    saveLeadOutput(lead);
    return lead;
  });

  writeLeads(seededLeads);
  console.log(`✅ Seeded ${seededLeads.length} sample leads`);
}

// --- Routes ---

// List all leads (summary view)
app.get('/api/leads', (req, res) => {
  const leads = readLeads();
  const summaries = leads.map(({ id, submittedAt, status, intake, analysis }) => ({
    id,
    submittedAt,
    status,
    clientName: `${intake.firstName} ${intake.lastName}`,
    email: intake.email,
    phone: intake.phone,
    urgency: intake.urgency,
    practiceArea: analysis.label,
    inScope: analysis.inScope,
    confidence: analysis.confidence,
    riskFlagCount: analysis.riskFlags?.length || 0,
    missingInfoCount: analysis.missingInfo?.length || 0
  }));
  res.json(summaries);
});

// Get single lead (full detail)
app.get('/api/leads/:id', (req, res) => {
  const leads = readLeads();
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

// Submit new intake
app.post('/api/leads', (req, res) => {
  const intake = req.body;

  const required = ['firstName', 'lastName', 'email', 'matterDescription'];
  const missing = required.filter(f => !intake[f] || !intake[f].trim());
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const { analysis, drafts } = processIntake(intake);
  const lead = {
    id: uuidv4(),
    submittedAt: new Date().toISOString(),
    status: 'pending',
    intake,
    analysis,
    drafts
  };

  const leads = readLeads();
  leads.unshift(lead);
  writeLeads(leads);
  saveLeadOutput(lead);

  res.status(201).json(lead);
});

// Update lead status
app.patch('/api/leads/:id/status', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'in_review', 'accepted', 'declined', 'referred'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const leads = readLeads();
  const index = leads.findIndex(l => l.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Lead not found' });

  leads[index].status = status;
  leads[index].statusUpdatedAt = new Date().toISOString();
  writeLeads(leads);
  saveLeadOutput(leads[index]);

  res.json({ id: req.params.id, status });
});

// Add attorney note
app.post('/api/leads/:id/notes', (req, res) => {
  const { note, attorney } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'Note is required' });

  const leads = readLeads();
  const index = leads.findIndex(l => l.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Lead not found' });

  if (!leads[index].notes) leads[index].notes = [];
  leads[index].notes.push({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    attorney: attorney || 'Attorney',
    text: note
  });

  writeLeads(leads);
  res.status(201).json(leads[index].notes);
});

// --- Start ---

loadSampleData();
app.listen(PORT, () => {
  console.log(`\n🏛️  GuideHerd Legal Intake Copilot — Backend`);
  console.log(`   Running at http://localhost:${PORT}`);
  console.log(`   Data file: ${DATA_FILE}\n`);
});
