# Processor Instructions — GuideHerd Legal Intake Copilot

> **Demo document.** All content is fictional and used solely for the GuideHerd Legal Intake Copilot demonstration.

---

## Overview

`scripts/process-demo-intakes.js` reads `data/demo-intakes.json`, processes each of the three fictional demo intakes, and writes:

- `outputs/demo-processed-intakes.json` — full output records (attorney-facing)
- `outputs/demo-attorney-summaries.md` — attorney summary markdown
- `data/demo-processed-intakes.json` — browser-safe copy for the HTML demo

---

## Step-by-Step Processing Instructions

### Step 1 — Classify Matter

1. Search `matter_description` and `parties_involved` for keyword matches.
2. Refer to `Practice_Areas.md` for keyword lists.
3. Set `classification` to the best-matching practice area, or `"Out of Scope"`.
4. Set `fit_status` to `"in_scope"`, `"out_of_scope"`, or `"needs_review"`.
5. Set `confidence_score` (0–100) based on keyword match strength.

### Step 2 — Assess Urgency

1. Look for deadline indicators: court dates, statute of limitations language, demand letters.
2. Apply urgency rules from `Intake_Rules.md`.
3. Set `urgency` to `"low"`, `"medium"`, `"high"`, or `"emergency"`.

### Step 3 — Extract Conflict-Check Names

1. Extract the submitter's full name → role: `"client"`.
2. Extract any named opposing parties → role: `"opposing_party"`.
3. Extract any business entities → role: `"entity"`.
4. Extract referenced third parties → role: `"referenced_third_party"`.
5. Append the required disclaimer from `Conflict_Check_Rules.md`.
6. **Never state whether a conflict exists or is cleared.**

### Step 4 — Identify Missing Information

1. Check for each required field from `Intake_Rules.md`.
2. List each gap as a plain-language string in `missing_information[]`.

### Step 5 — Generate Consultation Questions

Based on the matter type and missing information, generate 4–6 specific questions the attorney may ask at the initial consultation.

### Step 6 — Flag Internal Warnings

List any risk factors, urgency triggers, or attorney-attention items in `internal_warnings[]`. Examples:
- "Client mentions a specific deadline — verify statute of limitations."
- "Prior attorney mentioned — check for conflicts and fee disputes."
- "High estimated value — engage senior attorney for initial review."

### Step 7 — Write Attorney Summary

Write a concise internal summary (3–5 paragraphs) for the reviewing attorney:
- What the prospective client says the matter is about
- Relevant facts and timeline elements
- Classification rationale
- Missing information and next steps
- Required header: `INTERNAL — ATTORNEY EYES ONLY — NOT FOR CLIENT DISTRIBUTION`
- Required footer: `This summary is a draft prepared by AI-assisted intake processing. It does not constitute legal advice and requires attorney review.`

### Step 8 — Write Client Acknowledgment Draft

Follow `Client_Acknowledgment_Template.md`:
- Begin with `[DRAFT]`
- Neutral, non-committal tone
- No advice, no representation, no conflict clearance
- Include all required disclaimers

### Step 9 — Assemble Output Record

Assemble a JSON record conforming to `Output_Schema.json`. Set:
- `demo_data_only: true`
- `not_legal_advice: true`
- `requires_human_approval: true`

### Step 10 — Write Outputs

- Write full records array to `outputs/demo-processed-intakes.json`
- Write markdown summaries to `outputs/demo-attorney-summaries.md`
- Copy the browser-safe JSON to `data/demo-processed-intakes.json`

---

## Validation

Run `scripts/validate-demo-outputs.js` after processing to confirm all safety constraints pass.

---

## Notes

- The processor uses Node.js built-in modules only (`fs`, `path`).
- All processing is deterministic — the same inputs always produce the same outputs.
- No network requests. No external APIs. No database connections.
