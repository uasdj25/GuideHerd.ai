# GuideHerd AI — Website Strategy

Positioning document. Hand this to a designer or use it as the spec for the homepage prototype that accompanies it.

---

## 1. Positioning

**One-liner.** GuideHerd AI helps established service businesses — practices, firms, and operators — put AI to work without the theater. Assessment, roadmap, implementation, training. In that order.

**Audience, in priority.**
1. Owner-operators of dental and medical practices (5–50 staff)
2. Law firms and professional services (10–100 staff)
3. Mid-market operators with a real P&L and no AI function yet

**What we refuse to be.** A GPT wrapper shop. A "prompt library." A generic "digital transformation" consultancy that ships decks. A hype channel.

**What we actually sell.** Judgment. The assessment and roadmap are the product; the implementation and training are how we earn the retainer.

---

## 2. Sitemap

```
/
├── Home
├── Services
│   ├── Implementation & Automation
│   └── Training & Consulting
├── Approach          ← our methodology, the "how"
├── Packages          ← tiered engagements with indicative pricing
├── Case Notes        ← short written case studies (no fake logos)
├── About
│   └── Team
├── Insights          ← essays / field notes (quarterly, optional at launch)
└── Contact
    ├── Book an assessment
    └── General inquiry
```

**Primary nav:** Services · Approach · Packages · About · Contact
**Secondary (footer):** Case Notes · Insights · Careers · Privacy

---

## 3. Homepage flow

Each section does one job. No filler.

1. **Hero.** Declarative headline, single CTA (assessment), a second quiet link to the approach.
2. **The problem, named.** Three sentences about why AI projects stall in owner-led businesses.
3. **Two pillars.** Implementation on one side, Training on the other. Equal weight.
4. **The approach.** Four-step methodology (Assess → Plan → Implement → Train). Numbered, dense.
5. **Who this is for.** Three verticals with concrete use cases.
6. **Packages.** Three tiers + a retainer option, with pricing that's honest about ranges.
7. **A brief case note.** One, not six. Written, not stat-stuffed.
8. **Founder voice.** Two paragraphs, signed.
9. **CTA band.** Assessment form entry point, with what you actually get.
10. **Footer.**

---

## 4. Homepage copy (draft)

**Hero H1:** AI that earns its keep.
**Subhead:** We help practices, firms, and service operators implement AI where it pays for itself — then train the people who'll use it.
**CTA:** Book a readiness assessment · Read the approach

**Problem section:** "Most AI projects inside owner-led businesses fail the same way: a pilot that never becomes a system, a tool nobody uses, a training session that doesn't stick. We work in the opposite direction — starting from the operations that actually cost you money, and staying until the team runs it without us."

**Pillar — Implementation.** "Process automation, executive assistants, business-intelligence dashboards, and the integrations that make them work. We ship what we scope."

**Pillar — Training.** "Role-based programs for executives and staff. Certification tracks. Internal champions. The point is not literacy; it's capability."

---

## 5. Services breakdown

### Implementation & Automation
- Business process automation (HR, Payroll/Finance, Accounting, IT, Cybersecurity, Compliance)
- Automation-as-a-Service (monthly retainer)
- AI-powered sales & marketing systems
- Executive AI assistants for managers and partners
- Business intelligence dashboards (revenue, operations, patient/client flow)
- Data & insights systems
- Licensing and integration of third-party AI tools
- End-to-end project implementation

### Training & Consulting
- AI readiness assessments
- Custom AI roadmaps with phased pricing
- Role-based training (executive, staff, specialist)
- Certification programs
- AI-generated training content libraries
- Tiered SMB training packages

**How we present pricing.** Ranges on the Packages page. Specifics after the assessment. No hidden numbers; no fully-public numbers either. The assessment itself is free for qualified businesses.

---

## 6. Packages

| Package | Best for | Starts at | What's inside |
|---|---|---|---|
| **Readiness Assessment** | First-time buyers | Complimentary (qualified) or $2,500 flat | 2-week diagnostic, written roadmap, priced implementation plan |
| **Roadmap & Pilot** | Firms ready to ship one thing | $15K–$35K | Roadmap + one scoped automation, live in 60 days |
| **Operator Program** | Practices scaling AI across ops | $8K–$18K / month | Automation-as-a-Service retainer, quarterly reviews, training |
| **Enterprise Engagement** | Mid-market with a portfolio of initiatives | Custom | Dedicated pod, multi-workstream delivery, executive coaching |

Training bolt-on: $2,000–$2,500 per session, or $18,000 for a six-session certification cohort.

A fifth, optional slot: **Performance-based revenue share** — framed as "we only propose this when the unit economics are obvious." Keeps credibility.

---

## 7. Differentiation

Five things to lean on, in messaging and proof:

1. **Vertical focus.** We say "dentists and law firms" out loud. Generic AI consultants don't.
2. **Assessment-first.** No selling before diagnosing. This shows up as a free written roadmap.
3. **Training is not an afterthought.** It's a pillar, not an upsell.
4. **We stay until it runs without us.** Retainer structure reflects this.
5. **We price honestly.** Ranges shown, specifics after scope.

Anti-buzzword list (do not use): revolutionary, cutting-edge, synergy, transform, unlock, game-changing, supercharge, 10x, democratize, empower, journey, solutions.

---

## 8. UX & design notes

- **Grid.** 12-col, 80px gutter on desktop. Oversized left margin (120–160px) on hero and section intros for that "quarterly" feel.
- **Type.** Editorial serif for display (Fraunces → swap for licensed IvyMode/Canela-adjacent later). Grotesk sans for body (Söhne or Inter Tight). Numbers in tabular figures.
- **Palette.** Paper off-white `#F5F3EE`, ink navy `#0E2A3F` (from the logo), teal accent `#2FA4A0` (from the logo's "AI"), single warm neutral `#C8A97A` used sparingly. No gradients.
- **Motion.** Restrained. Section reveals on scroll, no parallax, no auto-playing video.
- **Imagery.** If used, photography of real operators' hands, workspaces, and paper — not AI-generated gradients or robots. Placeholders until real shoots happen.
- **Density.** Reading-room density. Long line-lengths on body copy (72ch), generous vertical rhythm (1.6 leading minimum).

---

## 9. CTA strategy

Three CTAs, in descending intent:

- **Primary:** "Book a readiness assessment." Every page, above fold and in closing band.
- **Secondary:** "Read the approach." Draws the cautious buyer into the methodology page.
- **Tertiary:** "Download the AI roadmap template." Email gate. Top-of-funnel only.

The assessment form itself should be short (6 fields) and should name what happens next: "You'll get a written roadmap within 10 business days."

Never put a "schedule a demo" button anywhere. We don't have a product.

---

## 10. What's in the prototype

The accompanying `Home.html` implements this document: hero, problem, two pillars, approach, verticals, packages, case note, founder voice, CTA band, footer. Inner pages (`Services`, `Approach`, `About`) stub out the next layer. Tweaks let you toggle hero layout, accent strength, and typography pairing without touching code.
