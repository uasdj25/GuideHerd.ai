# GuideHerd Academy — Paywall Architecture and Deployment Guide

## 1. Architecture overview

```
Browser
  │
  ├── Static HTML/CSS/JS  ←  Cloudflare Pages (training-portal/)
  │
  ├── GET  /api/access         ←  Pages Function — checks session + D1
  ├── GET  /api/me             ←  Pages Function — returns session user
  ├── POST /api/checkout       ←  Pages Function — creates Stripe Checkout session
  ├── POST /api/portal         ←  Pages Function — creates Stripe Billing Portal session
  ├── POST /api/stripe/webhook ←  Pages Function — handles Stripe events, writes D1
  └── GET  /api/account/verify ←  Pages Function — exchanges Stripe session_id for app session
                                                    cookie, called from /account/success
  D1 Database (binding: DB)
    ├── users
    ├── stripe_customers
    ├── subscriptions
    ├── access_entitlements
    └── audit_events
```

**Access control is enforced server-side.** Client-side JS (`js/access.js`) reads
`/api/access` and shows or hides content based on the response. It never decides
access on its own — the server decides. Removing or bypassing the client JS does
not grant access to protected content because content is not hidden by CSS alone;
it is not rendered until the server confirms access (future: server-side rendering
or signed URL asset delivery).

**Production default:** `hasAccess: false` unless a valid session cookie is
present, the session resolves to a user in D1, and that user has an active row
in `access_entitlements`.

---

## 2. Cloudflare Pages project settings

| Setting | Value |
|---------|-------|
| Root directory | `training-portal` |
| Build command | `npm install` |
| Build output directory | `/` (root of training-portal) |
| Deploy branch | `main` |
| Functions directory | `training-portal/functions` (automatic) |

Cloudflare Pages detects `functions/` automatically and compiles TypeScript
functions using esbuild. No additional build configuration is required.

---

## 3. D1 database creation

```bash
# Create the database
wrangler d1 create guideherd-academy-db

# Note the database_id in the output — add it to wrangler.toml

# Run the initial migration against production
wrangler d1 migrations apply guideherd-academy-db

# Run against local dev
wrangler d1 migrations apply guideherd-academy-db --local
```

---

## 4. D1 binding name

The code expects the D1 binding to be named **`DB`**.

Configure this in the Cloudflare Pages dashboard:
Settings → Functions → D1 database bindings → Add binding → Variable name: `DB`

---

## 5. Migration instructions

All migrations live in `training-portal/migrations/`.

| File | Description |
|------|-------------|
| `0001_initial.sql` | Creates all tables and indexes |

Apply migrations with:
```bash
wrangler d1 migrations apply guideherd-academy-db
```

Migrations are applied in filename order. Always add new migrations as new files
rather than modifying existing ones.

---

## 6. Stripe product and price setup

Create these products and prices in the Stripe dashboard, then add the Price IDs
to your environment variables.

| Plan key | Product name | Billing |
|----------|-------------|---------|
| `academy_monthly` | GuideHerd Academy | Monthly $149 |
| `academy_annual` | GuideHerd Academy | Annual $1,500 |
| `academy_founding_monthly` | GuideHerd Academy (Founding) | Monthly $99 |
| `academy_plus_monthly` | GuideHerd Academy Plus | Monthly $399 |
| `academy_plus_annual` | GuideHerd Academy Plus | Annual $4,000 |
| `workflow_support_monthly` | GuideHerd Workflow Support | Monthly $750 |
| `workflow_support_annual` | GuideHerd Workflow Support | Annual $7,500 |

All plans are recurring subscriptions. Set `billing_scheme: per_unit`.

---

## 7. Required environment variables

Set these in the Cloudflare Pages dashboard under Settings → Environment variables.
**Do not commit values to the repo.**

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `STRIPE_ACADEMY_MONTHLY_PRICE_ID` | Price ID for Academy monthly |
| `STRIPE_ACADEMY_ANNUAL_PRICE_ID` | Price ID for Academy annual |
| `STRIPE_ACADEMY_FOUNDING_MONTHLY_PRICE_ID` | Price ID for founding rate |
| `STRIPE_ACADEMY_PLUS_MONTHLY_PRICE_ID` | Price ID for Academy Plus monthly |
| `STRIPE_ACADEMY_PLUS_ANNUAL_PRICE_ID` | Price ID for Academy Plus annual |
| `STRIPE_WORKFLOW_SUPPORT_MONTHLY_PRICE_ID` | Price ID for Workflow Support monthly |
| `STRIPE_WORKFLOW_SUPPORT_ANNUAL_PRICE_ID` | Price ID for Workflow Support annual |
| `PUBLIC_SITE_URL` | `https://training.guideherd.ai` (no trailing slash) |
| `SESSION_SECRET` | Random 32-byte hex string — `openssl rand -hex 32` |
| `ALLOW_MOCK_ACCESS` | Leave blank in production. Set to `"true"` for local dev only. |

---

## 8. Stripe webhook setup

1. In the Stripe dashboard → Developers → Webhooks → Add endpoint.
2. Endpoint URL: `https://training.guideherd.ai/api/stripe/webhook`
3. Listen for these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
4. Copy the signing secret (`whsec_...`) and add it to `STRIPE_WEBHOOK_SECRET`.

Webhook handling is idempotent: duplicate events are detected via `stripe_event_id`
in `audit_events` and ignored.

---

## 9. Local testing notes

### Prerequisites
- Node.js and npm installed
- Wrangler CLI: `npm install -g wrangler`
- Authenticated: `wrangler login`

### Local dev server
```bash
cd training-portal
npm install
wrangler pages dev . --d1 DB=guideherd-academy-db
```

This serves the static site and Pages Functions together on `http://localhost:8788`.

### Mock access (local only)
Add to a `.dev.vars` file in `training-portal/` (gitignored):
```
ALLOW_MOCK_ACCESS=true
SESSION_SECRET=any-local-secret
```

Mock access is refused if a live Stripe key (`sk_live_...`) is present, even if
`ALLOW_MOCK_ACCESS=true` is set — a safety guard against accidental staging exposure.

### Stripe CLI for local webhooks
```bash
stripe listen --forward-to http://localhost:8788/api/stripe/webhook
```

Use the webhook signing secret printed by `stripe listen` as `STRIPE_WEBHOOK_SECRET`
in `.dev.vars` during local testing.

---

## 10. Known MVP limitations

| Limitation | Impact | Resolution path |
|------------|--------|-----------------|
| No login page implemented | Users get a session via `/api/account/verify` after checkout, but cannot log back in after session expires | Add email magic link or SSO (Clerk, Auth0, Supabase) |
| Sessions are cookie-based with HMAC | Tokens cannot be revoked server-side | Add a `sessions` table to D1 and check it on every request |
| No lesson progress tracking | No per-lesson completion state | Add a `lesson_progress` table and populate it from the lesson pages |
| D1 binding required for all API routes | API routes return errors in static preview (python3 http.server) | Use `wrangler pages dev` for local API testing |
| No re-login flow | Sessions expire after 30 days with no way back in | Add magic link auth (see section 11) |

---

## 11. Production auth gap and recommended next step

**Current state:** Users receive a session cookie via `/api/account/verify` immediately
after successful Stripe Checkout. This is the only way to get a session. There is
no login page that issues sessions.

**What this means:** After a session expires (30 days), a subscriber cannot log back
in without going through checkout again, which would create a duplicate subscription.

**Recommended next step:** Add a passwordless email login (magic link).

Suggested path using Cloudflare Pages Functions only:

1. `POST /api/auth/request-link` — Accept email, look up user in D1, generate a
   signed token (HMAC, 15-minute TTL), send email via Resend or Postmark.
2. `GET /api/auth/verify-link?token=...` — Verify token, issue session cookie,
   redirect to `/academy/`.

This requires no third-party auth service and keeps all data in D1.

Alternatively, drop in Clerk or Auth0 and replace `getCurrentUser()` in
`functions/_lib/auth.ts` with their SDK's session validation.
