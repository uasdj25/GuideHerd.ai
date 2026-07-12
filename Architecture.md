GuideHerd Engineering Principles

1. GuideHerd owns the customer experience.

Customers interact with GuideHerd.

Never with vendor products.

⸻

2. Every external dependency hides behind a GuideHerd service.

Examples:

GuideHerd Scheduling Service
        ↓
Cal.com

GuideHerd Voice Service
        ↓
ElevenLabs

GuideHerd Calendar Service
        ↓
Microsoft Graph

Tomorrow those implementations can change.

The rest of the platform should never know.

⸻

3. GuideHerd speaks GuideHerd.

Our APIs, domain objects, events, and documentation use our language.

Not vendor terminology.

Never:

* Cal.com Event Type
* ElevenLabs Agent
* Microsoft Graph Event

Instead:

* Consultation Type
* Scheduling Assistant
* Appointment

⸻

4. Build products, not integrations.

Every feature must solve a customer problem.

Technology choices are implementation details.

⸻

5. Every manual configuration becomes a future Administration Portal feature.

If an engineer changes it twice…

…it probably belongs in the UI.

⸻

6. Receptionists are our primary users.

The attorney is the buyer.

The caller is the beneficiary.

The receptionist is the daily user.

Optimize for her experience.

(I actually love this one. It changes design decisions.)

⸻

7. Lex is an internal service.

Lex orchestrates GuideHerd.

GuideHerd is not Lex.

Replacing Lex should not require changing GuideHerd APIs.

⸻

8. Sessions are the source of truth.

Every customer interaction begins with a GuideHerd Session.

Everything else references it.

⸻

9. One problem exceptionally well.

Don’t solve intake.

Don’t solve CRM.

Don’t solve billing.

Become the best scheduling experience a law firm has ever seen.

Then expand.

⸻

10. Architecture should outlive technology.

Choose abstractions expected to remain valid for years.

Assume vendors, APIs, and models will change.

Design so GuideHerd does not.
