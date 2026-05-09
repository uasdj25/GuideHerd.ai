# Where AI Fails — And How to Catch It

**Module:** 1 — AI Foundations  
**Lesson:** 2 of 5  
**Reading time:** ~25 min

---

## The problem with AI errors

AI failures do not look like failures. The problem is that AI tools produce polished, well-structured, confident-sounding text even when the underlying content is wrong, incomplete, or fabricated.

This lesson covers the specific failure modes you need to know — not to make you distrust AI tools, but to make you a better reviewer of their output.

---

## Failure mode 1: Made-up facts (hallucination)

The model generates text that sounds factually accurate but is not. This includes invented case citations, made-up statistics, fictional company policies, and plausible-sounding regulation references that do not exist.

**How to catch it:** Verify any specific fact, figure, citation, or reference independently before using it.

---

## Failure mode 2: Missing context

The model only knows what you tell it. When context is missing, it fills the gap with plausible-sounding general content — which may be completely wrong for your situation.

**How to catch it:** Ask yourself: did I give the model enough context to answer this correctly? If the answer is no, the output needs more scrutiny — or the prompt needs to be redone.

---

## Failure mode 3: Overconfidence

AI tools do not reliably express uncertainty. A model that is 60% confident and one that is 99% confident may produce output that reads exactly the same way.

**How to catch it:** Treat confident AI output the same way you treat uncertain AI output when the stakes are high.

---

## Failure mode 4: Bad assumptions

When a prompt is ambiguous, the model picks an interpretation and runs with it — without telling you it made a choice.

**How to catch it:** Read the output carefully to confirm the model addressed what you actually meant.

---

## Failure mode 5: Outdated information

Language models have a training cutoff. Anything that changed after that date is not in the model's training data unless you provide it.

**How to catch it:** For anything time-sensitive, check when the model's training data ends and provide current documents.

---

## Failure mode 6: Source mismatch

When a model summarizes a document you provided, it may occasionally summarize things not in the document, or attribute claims to the wrong section.

**How to catch it:** Spot-check key claims against the original source when accuracy to a specific document matters.

---

## Failure mode 7: Boundary crossing

AI tools sometimes do more than you asked — adding recommendations, judgments, or conclusions you didn't request.

**How to catch it:** Check whether the output stayed within the scope of what you asked.

---

## The right posture

AI output is draft material that requires review — not a finished product. The failure modes above happen regularly and tend to happen in ways that are easy to miss if you are not looking for them.

---

## Review checklist

- [ ] I understand that AI failures often look polished — confident writing is not evidence of accurate content.
- [ ] I would verify any specific fact, citation, or figure before using it in client-facing work.
- [ ] I understand that missing context in my prompt means the model fills gaps with plausible-sounding assumptions.
- [ ] I know to check for training data cutoffs when asking about current regulations, policies, or events.
- [ ] I understand that AI output may stray beyond the scope of what I asked, and I check for that before using it.
