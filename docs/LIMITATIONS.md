# Known Limitations

## Classification Engine

- **Rule-based keyword matching** — not a trained model. Works well for clear matters; breaks down on ambiguous or multi-issue intakes (e.g., a business dispute with criminal implications).
- **Confidence scores are heuristic** — based on keyword hit rate and margin, not calibrated probabilities. Treat as a relative signal, not an absolute measure.
- **Single-label classification** — assigns one practice area per intake. Real matters often span multiple areas (e.g., employment + benefits, real estate + contract).
- **No sub-classification** — "Business & Commercial" doesn't distinguish contract disputes from fraud, partnership dissolution, UCC matters, etc.
- **English only** — the keyword lists are English-language. Non-English intakes will not classify correctly.

## Conflict-Check Names

- **Heuristic extraction** — uses capitalized word-pair patterns + comma-split from the "other parties" field. Will miss:
  - Names written in all-caps or all-lowercase
  - Names embedded in complex sentences without clear separation
  - Entity abbreviations (e.g., "the Company," "Acme")
  - Foreign names that don't match Western capitalization conventions
- **False positives possible** — any capitalized phrase may be captured (e.g., "Superior Court" could appear as a name candidate)
- **This is NOT a conflict check** — it is an extraction of names for an attorney to run through the firm's actual conflict screening system

## Missing Info Detection

- **Operates on presence of topic keywords**, not semantic completeness. A client who writes "no will exists" satisfies the "will exists" check even though the answer is negative.
- **No follow-up loop** — the system doesn't ask clarifying questions; it flags gaps for the attorney to address at the consultation call.

## Communications

- **No real email integration** — draft text only. Copy-paste to send.
- **Generic firm placeholder** — "Hargrove & Associates" is fictional. Production use requires customization of firm name, contact info, and disclaimer language reviewed by the firm's ethics counsel.
- **Disclaimer language is not legal advice** — the acknowledgment templates were written for demo purposes. They should be reviewed and approved by a licensed attorney before use in any real firm context.

## Data & Storage

- **JSON flat file** — not suitable for production. No concurrent write safety; no backups; no encryption at rest.
- **No authentication** — the demo server has no login, API keys, or access control. Do not expose to the public internet.
- **No audit log** — status changes and note additions are not logged with timestamps in a tamper-evident way.

## Scope

- **Small firm demo only** — not designed for high intake volume, multi-office use, or matter management integration.
- **No statute of limitations calculation** — risk flags mention SOL concerns but do not calculate or advise on deadlines.
- **No fee/cost estimation** — no engagement economics modeling.
- **No court date tracking** — urgency is self-reported; no calendar integration.
