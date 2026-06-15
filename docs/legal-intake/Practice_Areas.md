# Practice Areas — Madison Valley Law Group

> **Demo document.** All content is fictional and used solely for the GuideHerd Legal Intake Copilot demonstration.

---

## In-Scope Practice Areas

The following matter types fall within the firm's current practice:

| Practice Area | Common Matter Types | Keywords |
|---------------|---------------------|----------|
| **Estate Planning** | Wills, trusts, powers of attorney, advance directives | will, trust, estate plan, beneficiary, heir, power of attorney, healthcare directive |
| **Probate** | Estate administration, will contests, intestate succession, executor disputes | probate, executor, estate, decedent, intestate, will contest, inheritance, administrator |
| **Small Business Disputes** | Breach of contract, unpaid invoices, partnership disputes, vendor conflicts | invoice, unpaid, breach, contract dispute, partnership, LLC, business dispute, vendor |
| **Contract Review** | Business agreements, service contracts, NDAs, lease review | contract, agreement, review, NDA, non-disclosure, lease, terms |
| **Real Estate Transactions** | Purchase/sale agreements, title issues, boundary disputes, closings | real estate, property, closing, title, deed, boundary, easement |

---

## Out-of-Scope Matter Types

The following matter types are **not** handled by this firm. Inquiries in these categories should be referred to appropriate counsel:

| Matter Type | Notes |
|-------------|-------|
| Criminal Defense | Any criminal charge, DUI, misdemeanor, felony |
| Divorce / Family Law | Divorce, legal separation, custody, child support, adoption |
| Immigration | Visa, citizenship, deportation, asylum |
| Bankruptcy | Chapter 7, Chapter 13, debt discharge |
| Personal Injury | Auto accidents, slip and fall, medical malpractice |
| Tax Controversy | IRS disputes, tax court, audit representation |

---

## Classification Guidance (for Intake Processor)

When classifying an intake:

1. Search the matter description for keywords associated with each in-scope area.
2. Also check for out-of-scope keywords and flag accordingly.
3. If multiple areas match, select the primary area and note secondary areas.
4. If the matter is ambiguous, set `fit_status` to `"needs_review"`.
5. Never tell the prospective client whether the firm will take their case.
