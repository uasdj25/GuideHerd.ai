# GuideHerd Legal Intake Copilot

AI-assisted intake processing demo for small law firms.

> ⚠️ **Demo system — all data is fictional.** This tool does not provide legal advice,
> conduct conflict checks, send emails, or create attorney-client relationships.
> All AI-generated content requires attorney review before any action is taken.

---

## What It Does

A prospective client submits a legal inquiry. The system instantly:

1. **Classifies** the matter type (Probate, Business, Real Estate, Employment, or out-of-scope)
2. **Extracts** party names for conflict-check screening
3. **Identifies** missing information to gather at the consultation call
4. **Flags** risks (urgency, deadlines, prior counsel, high-value matters)
5. **Drafts** a safe acknowledgment email for attorney review
6. **Generates** a confidential attorney summary in Markdown

Everything runs in the browser — no backend, no server, no API keys required.

---

## Run Locally

**Requirements:** Node.js 18+ and npm

```bash
cd legal-intake-demo
npm install
npm run dev
# Open http://localhost:3000
```

**Other scripts:**

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Vite dev server on port 3000 |
| `npm run build` | Build static site to `dist/` |
| `npm run preview` | Preview the production build locally |

---

## Deploy to Cloudflare Pages

### 1. Push this repo to GitHub

```bash
git remote add origin https://github.com/<your-org>/guideherd.git
git push -u origin main
```

### 2. Create the Pages project

1. Go to **Cloudflare Dashboard → Workers & Pages → Pages**
2. Click **Create a project → Connect to Git**
3. Select your GitHub account and choose the **guideherd** repo
4. Configure the build:

| Setting | Value |
|---------|-------|
| **Production branch** | `main` |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Root directory** | *(leave blank — repo root)* |
| **Node.js version** | `18` (set in Environment Variables: `NODE_VERSION = 18`) |

5. Click **Save and Deploy**

### 3. Add the custom domain `demo.guideherd.ai`

1. In your Pages project, go to **Custom domains → Set up a custom domain**
2. Enter `demo.guideherd.ai` and click **Continue**
3. Cloudflare will show you a DNS record to add — it will be one of:
   - **CNAME** `demo` → `<your-project>.pages.dev` (if guideherd.ai is on Cloudflare DNS)
   - **CNAME** record added automatically (if guideherd.ai DNS is already managed in Cloudflare)
4. If guideherd.ai is already on Cloudflare, the record is added automatically. Click **Activate domain**.
5. SSL is provisioned automatically — allow 1–2 minutes.

### 4. Verify the deployment

- Visit `https://demo.guideherd.ai` (or `https://<project>.pages.dev`)
- You should see the dashboard with three pre-loaded sample leads
- Click a lead → Analysis tab should show classification details
- Click **+ New Intake** and submit a test form → result appears immediately
- Click **↺ Reset demo** on the dashboard to restore the three samples

---

## Architecture

```
legal-intake-demo/
├── src/
│   ├── lib/processor.js      # Classification engine (runs in browser, no API)
│   ├── data/sampleLeads.js   # Three pre-processed fictional demo leads
│   ├── store/useLeads.js     # localStorage state hook (replaces all API calls)
│   ├── pages/
│   │   ├── Dashboard.jsx     # Lead list + stats
│   │   ├── IntakeForm.jsx    # Intake submission form
│   │   └── LeadDetail.jsx    # Analysis / Drafts / JSON / Notes tabs
│   ├── App.jsx               # Router shell
│   └── index.css             # All styles
├── public/
│   └── _redirects            # Cloudflare Pages SPA fallback
├── index.html
├── vite.config.js
└── package.json
```

**No backend.** All processing happens client-side. State persists in `localStorage` for the duration of the demo session.

---

## Sample Leads (Pre-loaded)

| Client | Matter | Classification | In Scope |
|--------|--------|----------------|----------|
| Margaret Chen | Estate dispute / will contest | Probate & Estate — 93% | ✅ Yes |
| Antonio Rosario | Unpaid $32,500 invoice | Business & Commercial — 78% | ✅ Yes |
| Derek Wilson | First-offense DUI | Criminal Defense — 81% | 🚫 No |

---

## Hard Rules (Enforced in Code)

- No emails are sent — drafts are text only, copy-paste to send
- No legal advice — all summaries are labeled as informational drafts
- No conflict determination — names extracted for attorney-run screening only
- No attorney-client relationship — all messaging is explicit about this
- No real data — all sample names, emails, and facts are fictional

---

## Known Limitations

See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for a full list. Key ones:

- Classification is keyword-based, not LLM-backed — struggles with ambiguous or multi-issue matters
- Conflict name extraction uses heuristics and will miss some names / produce false positives
- State is stored in browser `localStorage` — clears if the user clears browser data
- No authentication — anyone with the URL can view and interact with the demo

## Next Improvements

See [`docs/NEXT_IMPROVEMENTS.md`](docs/NEXT_IMPROVEMENTS.md). The highest-impact upgrade is replacing the keyword classifier with a Claude API call for true semantic understanding.
