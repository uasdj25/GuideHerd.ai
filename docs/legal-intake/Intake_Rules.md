# Intake Processing Rules — Madison Valley Law Group

> **Demo document.** All content is fictional and used solely for the GuideHerd Legal Intake Copilot demonstration.

---

## Purpose

These rules govern how the AI-assisted intake processor handles prospective client inquiries. They are enforced in `scripts/process-demo-intakes.js` and validated in `scripts/validate-demo-outputs.js`.

---

## General Rules

1. **Every output record must set `not_legal_advice: true`.**
2. **Every output record must set `requires_human_approval: true`.**
3. **Every output record must set `demo_data_only: true`.**
4. **No output may tell the prospective client the firm will represent them.**
5. **No output may advise the prospective client on the merits of their matter.**
6. **No output may state that a conflict check has been cleared.**
7. **All client-facing drafts must be visibly marked `[DRAFT]`.**
8. **All attorney-facing summaries must be labeled as internal working documents.**

---

## Classification Rules

1. Classify each intake into exactly one primary practice area (or "Out of Scope").
2. Assign a `fit_status`:
   - `"in_scope"` — matter matches a practice area and no disqualifiers found
   - `"out_of_scope"` — matter matches an excluded area
   - `"needs_review"` — ambiguous; attorney must decide
3. Assign a `confidence_score` (0–100) reflecting match strength.
4. List `secondary_areas` if multiple practice areas are implicated.

---

## Urgency Rules

Assign `urgency` as one of: `"low"`, `"medium"`, `"high"`, `"emergency"`.

| Trigger | Urgency |
|---------|---------|
| Statutes of limitations mentioned, deadlines within 30 days | `"high"` |
| Court dates, filings, or hearings scheduled | `"emergency"` |
| Active dispute, demand letters sent | `"medium"` |
| Planning stage, no active dispute | `"low"` |

---

## Conflict Check Rules

- Extract all names and entities from the intake form.
- Include: full names, business names, referenced third parties.
- Label output as `conflict_check_names` — extraction only, no determination.
- **Never state that a conflict has or has not been identified.**

---

## Missing Information Rules

Flag any of the following if absent:
- Full name and contact information
- Jurisdiction or location of the matter
- Key dates (incident date, filing dates, deadlines)
- Names of opposing parties
- Existence of written agreements or documents
- Prior or current attorney representation

---

## Output Tone Rules

- Attorney summaries: direct, factual, internal professional tone.
- Client acknowledgments: neutral, welcoming, non-committal.
- No promises. No predictions. No advice.
