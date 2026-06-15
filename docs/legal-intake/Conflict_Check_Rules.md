# Conflict Check Rules — Madison Valley Law Group

> **Demo document.** All content is fictional and used solely for the GuideHerd Legal Intake Copilot demonstration.

---

## Purpose

These rules govern how the intake processor extracts names and entities for conflict-of-interest screening. **The processor does not determine whether a conflict exists.** That determination is made exclusively by a licensed attorney after a full review.

---

## What the Processor Does

1. Extracts all proper names and business entities mentioned in the intake form.
2. Categorizes them as: `"client"`, `"opposing_party"`, `"referenced_third_party"`, or `"entity"`.
3. Stores results in `conflict_check_names[]` in the output record.
4. Appends a mandatory disclaimer: *"Conflict screening must be conducted by an attorney. This list may be incomplete."*

## What the Processor Does NOT Do

- Does **not** search any database.
- Does **not** compare against existing clients.
- Does **not** state whether a conflict exists or has been cleared.
- Does **not** advise the prospective client about conflicts.

---

## Extraction Heuristics

| Pattern | Category |
|---------|----------|
| First + Last Name of person submitting form | `"client"` |
| Names mentioned as adverse/opposing parties | `"opposing_party"` |
| Named attorneys, mediators, courts | `"referenced_third_party"` |
| Business names, LLCs, corporations | `"entity"` |
| Estates (e.g., "Estate of John Doe") | `"entity"` |

---

## Required Output Warning

Every output record must include the following in `conflict_check_names.disclaimer`:

> *"This name list is extracted for conflict-screening purposes only. It may be incomplete or inaccurate. An attorney must conduct a full conflict-of-interest review using the firm's client database before any substantive discussion occurs. This output does not represent a conflict clearance."*

---

## Hard Constraints

- Output must never contain the phrase "conflict cleared" or "no conflict found."
- Output must never contain the phrase "conflict is cleared."
- Output must never imply that the firm has screened and approved the prospective client.
