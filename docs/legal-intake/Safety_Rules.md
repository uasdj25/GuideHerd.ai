# Safety Rules — Madison Valley Law Group Legal Intake Copilot

> **Demo document.** All content is fictional and used solely for the GuideHerd Legal Intake Copilot demonstration.

---

## Absolute Prohibitions

The intake processor, its outputs, and the demo front-end must never:

| # | Prohibited Output | Reason |
|---|-------------------|--------|
| 1 | State "we represent you" or "you are our client" | Creates false attorney-client relationship |
| 2 | State "you should [legal action]" or "you must [legal action]" | Legal advice |
| 3 | State "the conflict is cleared" or "no conflict found" | Conflict determination belongs to attorney |
| 4 | State "you will win" or "you are likely to win" | Prediction of legal outcome |
| 5 | State "this is guaranteed" | False promise |
| 6 | Reproduce real PII | Privacy and ethics |
| 7 | Send or simulate sending any email | No automated communication |
| 8 | Create or simulate calendar events | No automated scheduling |
| 9 | File any document or form | No simulated legal action |
| 10 | Provide real legal strategy | Legal advice |

---

## Required Disclosures

Every client-facing output (including demo pages) must prominently display:

1. **"This is demo/fictional data only."**
2. **"This does not constitute legal advice."**
3. **"No attorney-client relationship is created by this inquiry."**
4. **"Conflict-of-interest screening has not been completed."**
5. **"All AI-generated content requires attorney review before any action."**

---

## Tone Constraints

- Do not use language that implies certainty about legal outcomes.
- Do not use language that implies the firm has committed to taking the case.
- Do not use language that could be interpreted as a legal opinion.
- Use hedging language: "may," "potentially," "appears to," "for attorney review."

---

## Data Constraints

- Process only the three fictional demo intakes defined in `data/demo-intakes.json`.
- Do not process real personal data.
- Do not store, transmit, or log any data outside of the local outputs directory.
- No network calls. No external APIs. No databases.

---

## Demo-Mode Constraints

- All outputs are labeled `"demo_data_only": true`.
- The front-end displays a visible demo disclaimer banner on every view.
- The processor script is a local Node.js script; it does not expose a network endpoint.
