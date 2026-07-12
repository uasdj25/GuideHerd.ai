# Training Portal — Deployment Guide

## Intended subdomain

`training.guideherd.ai`

The training portal is a separate static site from the main GuideHerd site. It lives in the `training-portal/` directory in this repo and should be deployed as a separate Cloudflare Pages project (not as a subdirectory of the main site).

---

## Cloudflare Pages setup

1. In the Cloudflare dashboard, create a new Pages project.
2. Connect it to the same GitHub repo, but set the **root directory** to `training-portal/`.
3. No build command is needed — this is a plain static HTML site.
4. Set the output directory to `/` (the training-portal root).

For the Stripe Worker and any future auth endpoints, you will also need a **Cloudflare Worker** deployed separately (see Stripe section below).

---

## DNS / custom domain

1. In Cloudflare Pages → Custom domains, add `training.guideherd.ai`.
2. Cloudflare will prompt you to add a CNAME record pointing to your Pages project. Add it in the Cloudflare DNS dashboard for `guideherd.ai`.
3. SSL is handled automatically by Cloudflare.

---

## Local development

Because the site uses root-relative paths (`/css/academy.css`, `/js/access.js`), you cannot open HTML files directly from the filesystem. Run a local server from the `training-portal/` directory:

```bash
cd training-portal
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

---

## Stripe setup

Stripe Checkout requires a server-side session. The static site cannot do this on its own. You need a **Cloudflare Worker** that:

1. Receives a POST to `/api/create-checkout`
2. Creates a Stripe Checkout session using `STRIPE_SECRET_KEY`
3. Returns the session URL to the client
4. Handles webhook events at `/api/stripe-webhook` using `STRIPE_WEBHOOK_SECRET`

`js/stripe-stub.js` contains the client-side stubs and pseudocode comments for the server-side logic. The stub intercepts button clicks and alerts the user that checkout is not yet wired up.

### Required Stripe products and prices

Create these in the Stripe dashboard and copy the Price IDs into your `.env`:

| Plan | Billing | Env var |
|------|---------|---------|
| Academy | Monthly | `STRIPE_PRICE_ACADEMY_MONTHLY` |
| Academy | Annual | `STRIPE_PRICE_ACADEMY_ANNUAL` |
| Plus | Monthly | `STRIPE_PRICE_PLUS_MONTHLY` |
| Plus | Annual | `STRIPE_PRICE_PLUS_ANNUAL` |

Support and Scoped plans use quote-based billing — no Stripe price needed for MVP.

---

## Required environment variables

See `.env.example` for the full list. These are consumed by the Cloudflare Worker, not the static site itself. Set them in the Cloudflare Worker dashboard under Settings → Variables.

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ACADEMY_MONTHLY` | Price ID for Academy monthly |
| `STRIPE_PRICE_ACADEMY_ANNUAL` | Price ID for Academy annual |
| `STRIPE_PRICE_PLUS_MONTHLY` | Price ID for Plus monthly |
| `STRIPE_PRICE_PLUS_ANNUAL` | Price ID for Plus annual |
| `PUBLIC_SITE_URL` | `https://training.guideherd.ai` (no trailing slash) |

---

## Auth and paywall — MVP gap

The MVP paywall is client-side only, controlled by a flag in `js/access.js`:

```javascript
var MOCK_ACCESS = true; // TODO: remove in production
```

With `MOCK_ACCESS = true`, all content is accessible to anyone who visits the site. This is intentional for development and review.

**Before going live**, replace the mock flag with real auth. Options:

- **Clerk** — easiest for small teams; handles login UI, JWTs, and user management
- **Auth0** — similar; more configuration overhead
- **Supabase** — open-source; good if you want a database alongside auth
- **Custom JWT Worker** — a Cloudflare Worker that issues signed JWTs after verifying a Stripe subscription; most control, most work

The paywall pattern is already in place in the HTML and JS. The only change needed is replacing `hasActiveSubscription()` in `js/access.js` with a real check (typically: verify a JWT stored in localStorage or a cookie, check the subscription status claim, return true/false).

---

## File structure

```
training-portal/
├── css/
│   └── academy.css          # All styles for the training portal
├── js/
│   ├── access.js            # Paywall/auth layer — replace MOCK_ACCESS for production
│   └── stripe-stub.js       # Stripe Checkout stubs — wire up with a Worker
├── content/
│   └── ai-foundations/      # Markdown source files (editorial source of truth)
├── academy/
│   ├── index.html           # Protected dashboard
│   └── ai-foundations/      # Module 1 lesson pages
├── index.html               # Public landing page
├── pricing.html             # Pricing page
├── login.html               # Login placeholder
├── subscribe.html           # Stripe Checkout entry point
├── .env.example             # Environment variable template
└── .gitignore
```

---

## Recommended next steps for production

1. Deploy the static site to Cloudflare Pages with `training-portal/` as the root directory.
2. Set up DNS and custom domain for `training.guideherd.ai`.
3. Create Stripe products and prices; save the Price IDs.
4. Build and deploy a Cloudflare Worker to handle Stripe Checkout and webhooks.
5. Set all environment variables in the Worker dashboard.
6. Choose an auth provider (Clerk recommended for speed); wire up `hasActiveSubscription()` in `js/access.js`.
7. Set `MOCK_ACCESS = false` and test the full login → subscribe → access flow.
8. Add Module 2 content by creating new HTML files in `academy/` and Markdown files in `content/`.
