# Safe Prompt Habits

**Module:** 1 — AI Foundations  
**Lesson:** 5 of 5  
**Reading time:** ~20 min

---

## Why prompts matter

The quality of AI output depends heavily on the quality of the input. A vague prompt produces vague output. An ambiguous prompt produces output that may address a different question than the one you had in mind.

Good prompt habits reduce errors, make output easier to review, and produce results that are closer to usable on the first pass.

---

## The five-part structure

### 1. Role

Tell the AI what role to take. This shapes the tone, vocabulary, and level of detail in the response.

Examples:
- "You are a professional editor reviewing a client communication for clarity."
- "You are an experienced legal intake coordinator."
- "You are a business analyst summarizing a set of intake notes."

### 2. Context

Provide the relevant background the model needs to do the task correctly. This is where most prompts fall short.

- What type of firm or practice is this for?
- What is the document or situation?
- Are there constraints the model should know about?

Apply the privacy rules from Lesson 4: provide the context the model needs, redact what is not necessary.

### 3. Task

Be specific about what you want the model to do.

- **Weak:** "Help me with this email."
- **Strong:** "Draft a follow-up email to a prospective client confirming their intake appointment and listing three documents they should bring."

### 4. Rules

Set constraints on what the model should and should not do.

Examples:
- "Do not include legal advice or opinions."
- "Do not mention fees or billing."
- "Use plain English. Avoid jargon."
- "Do not include information I have not provided — flag gaps instead."
- "Keep the response under 200 words."

### 5. Output format

Specify how you want the output structured.

Examples:
- "Return a bulleted list."
- "Write this as a professional email with a subject line."
- "Return a two-column table: issue on the left, recommended action on the right."

---

## The full prompt template

```
Role: [Describe the role the AI should take]

Context: [Provide relevant background — redact client names and sensitive details not needed for the task]

Task: [Describe specifically what you want the AI to produce]

Rules:
- [Constraint 1]
- [Constraint 2]
- [Add as many as the task requires]

Output format: [Describe how the output should be structured]
```

---

## A worked example

**Weak prompt:**
> "Write an email to a new client about their first appointment."

**Strong prompt:**
```
Role: You are a professional coordinator at a small law firm drafting client-facing communications.

Context: A new prospective client has completed a phone intake call. Their first in-person appointment is scheduled. The firm handles employment matters. The appointment is for an initial consultation only — no engagement has been established.

Task: Draft a confirmation email for the appointment. Confirm the date and time (use placeholders), list three standard documents the client should bring to an employment consultation, and explain that the meeting is an initial consultation and does not establish an attorney-client relationship.

Rules:
- Do not provide legal advice or express any opinion about the client's situation
- Do not mention fees or billing
- Keep the tone professional and plain
- Do not include any information I have not provided — use placeholders where specific details are needed

Output format: A professional email with a subject line. Under 200 words.
```

---

## Prompt review checklist

- [ ] My prompt includes a clear role that matches the type of output I need.
- [ ] I have provided enough context for the model to do the task correctly, and removed client details that are not necessary.
- [ ] My task description is specific enough that I could predict roughly what a correct response looks like.
- [ ] I have included rules that prevent the output from going beyond the scope of the task.
- [ ] I have specified the output format so the result is easy to review and use.
- [ ] I will review the output before using it, regardless of how good the prompt was.
