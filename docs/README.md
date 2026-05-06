# GuideHerd Legal Intake Copilot — Demo

A local demo for a small law firm showing AI-assisted legal intake processing.

> **Important:** This is a demonstration system only. It uses entirely fictional data.
> It does not provide legal advice, conduct conflict checks, send emails, or create
> attorney-client relationships. All AI-generated content is draft-only and requires
> attorney review before any action is taken.

---

## Quick Start

```bash
cd legal-intake-demo
./start.sh
```

Then open **http://localhost:3001** in your browser.

Requires **Python 3** (pre-installed on macOS) — no other dependencies needed.

---

## What It Does

1. **Intake Form** — Prospective client submits matter details
2. **Classification** — Automatically classifies matter type and determines in-scope/out-of-scope
3. **Conflict-Check Names** — Extracts all party names for attorney conflict screening
4. **Missing Info** — Identifies information gaps to address at consultation
5. **Risk Flags** — Surfaces urgent timelines, prior counsel issues, high-value matters
6. **Draft Acknowledgment Email** — Safe, lawyer-reviewed-before-send client response
7. **Attorney Summary** — Markdown brief for the reviewing attorney
8. **JSON Output** — Machine-readable record saved to `outputs/`

---

## Project Layout

```
legal-intake-demo/
├── server.py           ← Backend: API + file server (Python stdlib only)
├── start.sh            ← One-command startup
├── app/
│   └── index.html      ← Full React SPA (Preact CDN, no build step)
├── data/
│   └── leads.json      ← Local data store (auto-created, git-ignored)
├── outputs/            ← Per-lead JSON + Markdown files
├── samples/            ← Pre-generated sample outputs for all 3 demo leads
├── docs/               ← This file
├── backend/            ← Node.js version (if you prefer npm/Vite)
└── frontend/           ← React/Vite version (if you prefer npm/Vite)
```

---

## Sample Leads (Pre-loaded)

| Client | Matter | Classification | In Scope |
|--------|--------|----------------|----------|
| Margaret Chen | Estate dispute / will contest after mother's death | Probate & Estate | ✅ Yes |
| Antonio Rosario | Unpaid $32,500 contract — Pinnacle Property Group | Business & Commercial | ✅ Yes |
| Derek Wilson | First-offense DUI, arraignment Thursday | Criminal Defense | 🚫 No |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/leads` | List all leads (summary) |
| `GET` | `/api/leads/:id` | Full lead detail |
| `POST` | `/api/leads` | Submit new intake |
| `PATCH` | `/api/leads/:id/status` | Update status |
| `POST` | `/api/leads/:id/notes` | Add attorney note |

### POST /api/leads — required fields
```json
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "matterDescription": "string"
}
```

### PATCH /api/leads/:id/status — valid values
`pending` | `in_review` | `accepted` | `declined` | `referred`

---

## Node.js / Vite Version (Alternative)

If you have Node.js installed:

```bash
# Terminal 1 — backend
cd backend && npm install && node server.js

# Terminal 2 — frontend
cd frontend && npm install && npm run dev
# Open http://localhost:3000
```

The Vite frontend proxies `/api` to `localhost:3001`.

---

## Hard Rules Enforced

- No emails are sent — all drafts require explicit attorney approval
- No legal advice is given — summaries are informational only
- No conflict determination — names extracted for attorney-run screening only
- No attorney-client relationship — all messaging is explicit about this
- Fake demo data only — all sample names, emails, and facts are fictional

---

## Known Limitations

See `docs/LIMITATIONS.md` for full list.

---

## Next Improvements

See `docs/NEXT_IMPROVEMENTS.md` for roadmap.
