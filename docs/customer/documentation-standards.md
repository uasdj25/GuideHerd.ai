# Documentation Standards, Publishing, and Maintenance

This page is for the people who **write** GuideHerd's customer documentation.
Customers do not need to read it.

It defines what "good" looks like, how documentation gets published, and how it
stays true as the platform changes.

---

## 1. Who this documentation is for

Customer documentation is written for the people who run a law firm's front
office:

| Audience | Cares about |
|---|---|
| **Firm administrator** | Setting GuideHerd up, configuring it, managing people, fixing problems |
| **Receptionist** | Doing the job on a busy phone, quickly and without anxiety |
| **Firm owner / partner** | What the system does, whether it's working, what it costs them in effort |

None of them are engineers. None of them have read the codebase. None of them
care how it is built.

---

## 2. The rules

### Write in plain English

Short sentences. Ordinary words. If a sentence needs re-reading, rewrite it.

### Be task-oriented

Organize around what someone is trying to *do*, not around how the system is
structured internally. "Add a new practice area" is a task. "The configuration
domain model" is not.

### Explain *why*, not just *what*

The difference between a manual and useful documentation is the reason. A
receptionist who understands *why* the transfer window expires will handle an
expiry calmly instead of panicking.

Prefer: "The prepared session lasts 10 minutes so a caller who hangs up doesn't
leave a stale session waiting. If it expires, just prepare a new one — nothing
is lost."

Over: "Sessions expire after 10 minutes."

### Never expose internal implementation

**This is the rule most likely to be broken, so it is the one to check hardest.**

Customer documentation must never contain:

- ADR numbers or references ("per ADR-0013…")
- Internal architectural terminology — *contract*, *provider registry*,
  *outbox*, *capability token*, *policy engine*, *fail-closed*, *idempotent*
- Source file paths, function names, class names, database tables
- Environment variable names, configuration keys, or command-line flags —
  **anywhere**, including Installation & Deployment. That page describes
  deployment *decisions and consequences*; the variable reference lives in the
  internal operator documentation, so there is exactly one copy to keep true
- HTTP endpoints, status codes, or JSON payloads *except* in the Reference Guide
- Internal role or permission identifiers where a plain description works

Say "GuideHerd keeps each firm's information separate" — not "organization
scoping is enforced structurally."

Say "Sign-in isn't set up yet — contact your GuideHerd administrator" — not
"the user-auth provider returned 503."

### Distinguish guarantees from deployment behavior

A claim can be true of the GuideHerd software, true only of a particular storage
choice, or true only of one firm's deployment. Presenting the second or third as
the first is how documentation becomes either falsely reassuring or needlessly
alarming.

Separate them explicitly:

1. **Always true** — a guarantee of the software itself.
2. **Depends on your setup** — determined by the configured stores.
3. **Confirm with GuideHerd support** — a fact about a specific deployment that
   documentation cannot know.

Never state a storage-provider-specific behavior as universal. "A restart clears
your history" is false for a durable deployment; "whether history survives
depends on your storage — ask which you have" is true everywhere.

Where a fact cannot be proven for the reader's deployment, say so and say who to
ask. Accurate uncertainty beats a confident guess in either direction.

### Document only what actually exists

Never document a feature that isn't built, and never imply a capability the
product doesn't have. If something is planned, either leave it out or label it
plainly as not yet available.

Where a limitation will affect a customer's day, **say so directly**. A customer
who is surprised by a limitation loses trust; a customer who was told about it
up front plans around it.

### Include screenshots where they help

Screenshots earn their place when they show something hard to describe — a
screen layout, where a control lives, what a state looks like. They cost
maintenance, because they go stale silently. Don't screenshot what a sentence
can carry.

Store images in `docs/customer/images/` with descriptive names
(`reception-console-ready-to-transfer.png`).

### Keep it version-controlled

Documentation lives in the repository, in Markdown, and changes through the same
review process as code. Documentation is never edited in a separate system that
can drift.

---

## 3. Structure

```
docs/customer/
  README.md                      Navigation and index — start here
  getting-started.md             First-time orientation
  installation-and-deployment.md Deployment decisions and verification
  administrator-guide.md         Running GuideHerd day to day
  receptionist-guide.md          Using the Reception Console
  operations-guide.md            Monitoring what happened
  configuration-guide.md         Every setting and what it does
  troubleshooting-guide.md       When something looks wrong
  reference-guide.md             Lookup tables, limits, glossary
  documentation-standards.md     This page (internal)
  images/                        Screenshots
```

Guides are separate files rather than one large manual so that a reader lands on
the one that matches their role and job.

**New capabilities add sections to existing guides.** They should not require
restructuring. If a new feature genuinely doesn't fit any guide, that is a
signal worth discussing — a new top-level guide is a real decision, not a
default.

---

## 4. Documentation is part of "done"

**Every change that alters what a customer sees, does, or must configure
updates the relevant documentation in the same merge request.**

A feature is not complete when the code merges. It is complete when a customer
can find out how to use it.

Practical checklist for any customer-affecting change:

- [ ] Does a customer see, do, or configure anything new or different?
- [ ] Which guide covers it? (New setting → Configuration Guide. New screen →
      the guide for that role. New failure a customer might hit →
      Troubleshooting.)
- [ ] Do the Reference Guide's tables still hold — limits, timings, statuses?
- [ ] Have any screenshots gone stale?
- [ ] Does anything now describe a behavior that changed?

If a change is purely internal — refactoring, architecture, tests, performance
with no visible effect — no documentation change is needed. Say so explicitly in
the merge request so a reviewer knows it was considered rather than forgotten.

### Documentation that must not run ahead of reality

Some capabilities exist in the platform but are **not switched on** for
customers. Documentation describes what a customer can actually experience
today. Where a capability is available but off by default, say plainly that it
is off and how to ask for it — never write as though it were already live.

When such a capability is switched on, updating the documentation is part of
switching it on, not a follow-up.

---

## 5. Publishing strategy

**Today:** Markdown in the repository. Readable on the code host, reviewable
through merge requests, versioned with the platform. No build step, no
infrastructure, nothing to run. For the current customer base this is enough.

**Next, when the customer base makes it worthwhile:** a static documentation
site published from this same directory, so writing continues in Markdown and
the source of truth never moves.

The structure here is already built for that step:

- One directory, flat, predictable file names → clean URLs
- `README.md` as index → becomes the landing page
- Guides as separate files → become top-level navigation
- Headings are meaningful and unique → become anchor links
- Images in a sibling directory → move as-is
- No cross-references to internal documents that couldn't be published

Publishing should therefore be a build-and-host decision, not a rewrite.

**Rules for whenever that happens:**

1. Markdown in this repository stays the source of truth. Never fork content
   into a CMS.
2. Publishing is automated from the default branch, so published docs cannot
   drift from merged docs.
3. Internal documentation — architecture decisions, API specifications,
   operational runbooks — is **never** published to the customer site.
   `documentation-standards.md` (this page) is internal too.

---

## 6. Maintenance

**Continuously:** the definition-of-done checklist above. This is what actually
keeps documentation true; everything below is a safety net for what it misses.

**Each quarter, or after any significant release:**

- Walk the Getting Started path exactly as written, as a new customer would.
  Anything that doesn't match reality is a defect.
- Re-check the Reference Guide's numbers — timings, limits, retention.
- Review screenshots against the current interface.
- Re-read Troubleshooting against real support questions from the period. The
  questions customers actually asked are the best available list of
  documentation gaps.

**When a limitation is removed:** search the whole directory for the workaround
text and remove it. Stale workarounds are worse than no documentation — they
teach customers to do unnecessary work, and they quietly undermine trust in
everything else on the page.

**When you learn something from a support conversation:** write it down while
it is fresh. A support answer given twice belongs in the documentation.
