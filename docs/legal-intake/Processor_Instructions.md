# Processor Instructions

Run these commands from `guideherd-legal-intake-copilot/`:

```sh
node scripts/process-demo-intakes.js
node scripts/validate-demo-outputs.js
```

## What the processor does
- Reads `data/demo-intakes.json`
- Reads `data/classification-rules.json`
- Classifies each fake intake deterministically
- Extracts names/entities only for conflict review
- Produces attorney-facing summaries
- Produces DRAFT client acknowledgments
- Writes:
  - `outputs/demo-processed-intakes.json`
  - `data/demo-processed-intakes.json` (fallback copy for static preview)
  - `outputs/demo-attorney-summaries.md`

## What the validator checks
- Required schema fields exist
- `not_legal_advice` is `true`
- `requires_human_approval` is `true`
- Client acknowledgment includes `DRAFT`
- No output says the firm represents the person
- No output gives legal advice

## Notes
- No live endpoint.
- No external APIs.
- No dependencies.
- No legal advice.
- No conflict decision.
