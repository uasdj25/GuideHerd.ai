# Next Improvements

Priority order for moving from demo to production-ready.

---

## Tier 1 — Core for Any Real Use

### 1. LLM-Backed Classification
Replace the keyword processor with a Claude API call. Benefits:
- Handles ambiguous, multi-issue, and non-English intakes
- True semantic understanding of the description
- Sub-classification (e.g., distinguishes breach of contract from partnership dissolution)
- Returns structured JSON with reasoning explanation
- Confidence is a model-calibrated probability, not a heuristic

Implementation: `POST /api/leads` calls `claude-sonnet-4-6` with the intake text and a structured prompt. Cache the response per lead. Add streaming for the attorney summary.

### 2. Authentication & Authorization
- Attorney login (email/password or SSO)
- Role separation: intake staff vs. reviewing attorney vs. partner
- API key requirement for all endpoints
- No public-facing dashboard

### 3. Proper Database
Replace `leads.json` with SQLite (for single-office) or PostgreSQL (multi-user). Enables:
- Concurrent writes
- Full-text search across lead descriptions
- Query by date range, status, practice area
- Audit log table (who changed what, when)

### 4. Email Integration (Draft-Only, Human-Approved)
Wire the acknowledgment draft to a send button that:
1. Opens a review modal showing exactly what will be sent
2. Requires attorney to check a confirmation box
3. Uses SendGrid / Postmark / law firm's SMTP
4. Logs the send event with timestamp and sender

No auto-sending ever.

---

## Tier 2 — Usability & Workflow

### 5. Matter Management Integration
Export lead → Clio / MyCase / Practice Panther via API. Map fields:
- Client → Contact
- Matter description → Matter note
- Practice area → Matter type
- Status → Lead pipeline stage

### 6. Conflict Check Integration
Connect extracted names to the firm's conflict database (CSV, or Clio's conflict API) and return a preliminary result. Flag any potential matches for attorney review. Never auto-decide.

### 7. Intake Form Customization
Let the firm configure:
- Which practice areas are in scope
- Custom intake questions per practice area
- Firm name, logo, contact info in all templates
- Referral message text per out-of-scope area

### 8. Document Upload
Allow clients to attach supporting documents at intake (contracts, photos, correspondence). Store securely. Surface file list in the attorney view.

### 9. Consultation Scheduler
After attorney accepts a lead, offer the client a Calendly/Cal.com link for a consultation. Track scheduled vs. no-show vs. completed.

---

## Tier 3 — Analytics & Scale

### 10. Intake Analytics Dashboard
- Lead volume by week/month
- Acceptance rate by practice area
- Average time from submission to attorney review
- Source attribution (which referral sources convert best)
- Out-of-scope rate by category

### 11. Multi-Office / Multi-Firm
- Tenant isolation
- Per-firm practice area configuration
- Centralized conflict database across offices

### 12. Client Portal
Let the prospective client:
- Check the status of their intake
- Answer follow-up questions submitted by the attorney
- Upload documents securely
- Schedule a consultation

### 13. Statute of Limitations Alerts
For classified matter types, surface the applicable SOL range (jurisdiction-dependent) and flag if the submission date suggests urgency based on the dates mentioned in the description.

---

## Tech Stack for Production

| Layer | Demo | Production |
|-------|------|------------|
| Backend | Python stdlib | FastAPI + SQLAlchemy |
| AI | Rule-based | Claude API (claude-sonnet-4-6) |
| Database | JSON file | PostgreSQL |
| Auth | None | Auth0 / Clerk |
| Email | Draft text | SendGrid (human-approved) |
| Frontend | Preact CDN | Vite + React + TypeScript |
| Hosting | Local | Railway / Fly.io / AWS |
| Storage | Local files | S3 (documents) |
