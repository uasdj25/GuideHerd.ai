# Intake Rules

1. Use fake demo data only.
2. Classify the matter type first.
3. Mark scope fit as one of: `likely_fit`, `uncertain`, `unlikely_fit`, `refer_out`.
4. Probate / estate planning facts that match the firm profile should usually be `likely_fit`.
5. Small business unpaid invoice / contract dispute facts should usually be `likely_fit`.
6. Criminal defense facts should be `unlikely_fit` or `refer_out`.
7. If deadlines, hearings, arrests, eviction, imminent loss of rights, or emergency facts appear, raise urgency and flag human review.
8. Generate only administrative client acknowledgment drafts.
9. Every client-facing draft must be labeled `DRAFT`.
10. Every client-facing draft must require human approval before use.

