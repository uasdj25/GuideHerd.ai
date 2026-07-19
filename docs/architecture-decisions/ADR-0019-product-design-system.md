# ADR-0019: The GuideHerd Product Design System

**Status:** Accepted — Shipped with the Design System (`assets/guideherd.css`); consumed by the Operations Center, Reception Console (PR #30), and Administration Center (PR #33).
**Date:** 2026-07-18
**Relates to:** ADR-0014 (Operations Center — the reference
implementation), ADR-0007 (extension discipline, applied to
presentation), the GuideHerd Constitution (one product, one experience)

## Context

GuideHerd's applications each carried their own styling: the public
website established a distinctive editorial brand, the Reception
Console re-declared a compatible token block by hand, and the
Operations Center and Administration Center shipped as unstyled
utility pages (Georgia serif, gray hairlines) that looked like a
different company. As the platform grows applications — Operations,
Administration, a Customer Portal — each one restyling itself from
scratch guarantees drift. This ADR establishes the permanent GuideHerd
Product Design System so that every application reads as another
section of one product.

## Decision

### 1. guideherd.ai is the canonical brand source

The Design System is EXTRACTED from the public website, not designed
independently: its editorial "consulting quarterly" language — warm
paper (`#F5F2EA` family), ink navy (`#0E2A3F` with a 60/40/20/10/05
alpha ramp), teal accent (`#2FA4A0`/`#1E7C79`/`#0E6D6A`), muted tan
(`#C8A97A`), Fraunces serif display over Inter Tight sans UI, an
11→40px application type scale, the 8px spacing scale (`--sp-1..7`),
pill buttons, 2px-radius uppercase badges, 12px-radius cream cards,
hairline rules, uppercase letterspaced eyebrows, tabular numerals.
Nothing in the system reinterprets the brand; when the site and a
component disagree, the site wins and the component changes.

### 2. One shared stylesheet: `/assets/guideherd.css`

The single shared foundation every application links. It owns, in
order: design tokens (brand, semantic status, surface roles, type,
spacing, shape, focus), the reset, accessibility primitives
(focus-visible ring, skip link, visually-hidden, reduced-motion),
layout (`gh-container`, `gh-section`, section-header/eyebrow
hierarchy), the application header (sticky blurred paper, wordmark +
quiet uppercase area label: every product reads "GuideHerd AI ·
<application>"), buttons (`gh-btn` primary/outline/ghost/danger),
cards and stats (serif numerals over letterspaced labels), editorial
tables (ink top/bottom rules, uppercase column heads, hover-cream
rows), forms, search, semantic badges (ok/warn/bad/neutral with status
dot), alerts, empty states (serif-italic "All quiet."), loading
states, native-`<dialog>` dressing, key/value grids, and utilities.

**Status colors are the brand palette, semantically assigned** — ok is
the teal accent-ink, warn is the tan's ink, bad is the site's
red-flag. No new hues exist anywhere in the system.

### 3. The consumption contract

Applications link the stylesheet and compose `gh-` primitives; a page
stylesheet may only compose and add page-specific LAYOUT — it never
redefines palette, typography, spacing, or component treatments.
Components reference SEMANTIC tokens (`--surface`, `--text`,
`--line`, `--status-*`), which map onto brand tokens — so adopting the
design language is a `<link>` plus markup classes, never copied CSS.
Presentation stays strictly separate from behavior: the Operations
Center redesign changed markup and rendering helpers only — same API
calls, same flow, same IDs, zero server changes.

### 4. Dark-mode readiness is structural

A complete `[data-theme="dark"]` token remap ships in the stylesheet
(deep-navy paper, parchment ink, adjusted status backgrounds and focus
ring). No component knows about themes; flipping one attribute
restyles an entire application — verified in the browser. Nothing
ships dark mode yet; the decision here is that theming happens ONLY at
the token layer, so it never requires component changes.

### 5. The Operations Center is the reference implementation

`operations/index.html` demonstrates every pattern: branded sign-in
card, application header, stat cards, eyebrow sections, editorial
tables with status badges and mono identifiers, search, capability
health as card+badge grid, empty/loading states, aria-live regions,
labeled inputs, skip link, keyboard search (Enter submits), and
responsive behavior (stats reflow, tables scroll inside their own
wrapper, header compacts). Future applications copy its PATTERNS, not
its CSS.

### 6. Adoption path and evolution

- **Reception Console:** replace its hand-copied token block with the
  shared stylesheet; adopt the header, button, form, and alert
  primitives. Its caller-facing card layout already matches the
  language (it was the closest sibling).
- **Administration Center:** adopt header/sections/tables/forms/
  badges/dialogs — it is composed entirely of primitives the system
  already ships.
- **Future applications (Customer Portal, dashboards):** start from
  the stylesheet; new NEEDS become new `gh-` primitives added here
  (one place), never per-app styling.
- The system evolves like the platform's other contracts: additive
  primitives, no per-application forks, and the website remains the
  canonical source when the brand itself evolves.

## Consequences

- A customer moving from guideherd.ai into the Operations Center now
  stays visibly inside the same product — typography, palette,
  spacing, buttons, and hierarchy are literally the same definitions.
- Styling exists once: future applications inherit by linking, and
  drift requires actively bypassing the system rather than passively
  copying.
- Accessibility is foundation-level (focus language, skip links,
  reduced motion, labeled controls, aria-live) rather than
  per-page effort.
- Deliberately out of scope: UI frameworks and build steps (the
  platform stays lightweight HTML/CSS/JS), a component JavaScript
  library, dark-mode shipping, and the migration of the Reception
  Console/Administration Center (each is its own reviewed change on
  this foundation).
