# Pilot Security Review — 2026-07 (GitLab #39)

**Scope:** the pilot-ready system at Batch 5: API server (`server/`), the
three product surfaces, deployment posture (Railway API + Cloudflare Pages
site), and operational practices. **Method:** checklist-driven source
review with targeted live checks; every claim below names its evidence
(test suite, code path, or live header). No secret value was accessed.
**Standard:** real findings only — no theoretical vulnerabilities.

## Findings summary

| # | Area | Finding | Severity | Disposition |
|---|---|---|---|---|
| F1 | Authentication | No rate limiting on `POST /api/v1/auth/login` — unbounded credential guessing | Medium | **FIXED** (#39): per-client fixed-window limiter (30 attempts/10 min), credential-blind 429, telemetered; process-local by design (one instance) with a durable-limiter follow-up recorded |
| F2 | Headers | API responses lacked `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS | Low-Med | **FIXED**: set on every JSON response and the one HTML endpoint |
| F3 | Headers | Product pages lacked CSP and frame protection (login surfaces frameable → clickjacking-shaped risk) | Low-Med | **FIXED**: `_headers` for Cloudflare Pages — global nosniff/DENY/no-referrer/HSTS; CSP on the three product surfaces (self-hosted everything + the one API origin; `'unsafe-inline'` required by the pages' inline-script architecture — external injection still blocked) |
| F4 | Probes | `/healthz`/`/readyz` answered GET only; platform checkers often use HEAD | Info | **FIXED**: HEAD supported, no body |
| F5 | Contract | #66's 200-slot cap exceeds the 16 KB body cap (~100 typical slots) | Info | **Documented** in the slot-selection contract; real availability is far below both bounds |
| F6 | Limiting | The login limiter trusts the platform edge's `x-forwarded-for` | Info | **Accepted + documented**: Railway's edge sets it; direct-to-instance traffic isn't internet-reachable. Re-examine if the deployment topology changes |

## Verified sound (evidence-backed, no action)

- **Operational APIs authenticated** (priority item): every
  `/api/v1/operations/*` and `/api/v1/admin/*` route requires a session +
  permission; anonymous → 401, wrong role → 403 (operations/administration
  suites; live 401 checks each deploy).
- **Bearer-token enforcement** (priority item): service identities are
  SHA-256-hash-keyed static tokens; unknown/wrong bearer → 403 uniform;
  capability tokens (`handoff-token`) grant exactly `handoff:redeem`;
  console status/cancel use per-session capability tokens
  (identity/handoff suites).
- **Audit logging** (priority item): authorization denials and privileged
  successes write audit events; every administration change writes a
  versioned `configuration_audit` row with actor and before/after;
  authentication login/failed/logout are telemetered — with credentials
  structurally absent (allowlist + assertions).
- **Secrets management** (priority item): secrets live only in the
  deployment environment; at rest the platform holds SHA-256 digests
  (session tokens, user credentials, service tokens); the telemetry field
  allowlist makes secret/PII transport structurally impossible (tested);
  `npm audit --omit=dev`: **0 vulnerabilities** (runtime deps: `pg`
  8.16.3, pinned); `embedded-postgres` is dev-only, exact-pinned, its
  postinstall previously inspected (server/README).
- **Session handling**: opaque 256-bit tokens, HttpOnly/Secure/
  SameSite=Strict host-only cookie, hashes server-side, ABSOLUTE 12 h
  expiry, rotation-on-login (fixation), immediate logout invalidation —
  re-proven against the durable store (#64 lifecycle suite, both
  implementations). Deactivated users are cut off at next validation
  (#65); bootstrap identities are immune to directory state (recovery
  tier, #65 review).
- **CSRF**: SameSite=Strict + JSON-only bodies + exact-origin CORS
  allowlist with credentialed responses; no cookie-authenticated GET has
  side effects (route review).
- **XSS**: every dynamic `innerHTML` sink on the three product pages goes
  through `esc()` (sweep of all sinks this review); the summary and alert
  renderers HTML-escape (tested); CSP now backstops external injection.
- **Injection**: all SQL is prepared/parameterized; the only interpolated
  fragments are code-owned table/column identifiers, never input (sweep).
- **Privilege escalation**: closed PERMISSIONS catalog (unknown intents
  fail closed), closed role vocabulary, administration cannot widen
  either; org-scoping comes from the server-held session everywhere; the
  users area is policy-bounded with last-admin/self-deactivation/bootstrap
  guards (suites).
- **Customer data exposure**: Operations Center strips caller PII
  structurally; telemetry/claims/workflow state are bounded-scalar
  allowlists (suites); consultation summaries are never stored (delivered
  mail is the only copy).
- **Failure modes / recovery**: fail-loud boot on any misconfiguration;
  bounded provider requests (#60); bounded health checks (#38); tested
  backup/restore with a repeatable rehearsal (#62); configuration
  authority with evidence-based durability (#59); bootstrap recovery tier
  (#65).
- **Transport assumption, stated**: TLS terminates at the Railway/
  Cloudflare edges; in-cluster hop is platform-internal. HSTS now pinned
  at both edges. Acceptable for the pilot topology.

## Deferred (justified, with recommended follow-ups)

1. **Durable/global login limiter** — process-local is correct for the
   single-instance pilot; a shared limiter (PG-backed, reusing the claim
   pattern) should accompany any multi-instance move. *Recommend a GitLab
   issue paired with the instance-scaling decision.*
2. **CSP without `'unsafe-inline'`** — requires externalizing the product
   pages' inline scripts (a build change contrary to the current
   no-build architecture). Current CSP already blocks external injection.
   *Recommend folding into any future front-end build/tooling decision.*
3. **General API rate limiting** (beyond login and the existing
   prepared-session cap) — the authenticated surface is session-gated and
   organization-scoped; the anonymous surface is the console pair already
   capped per firm. *Recommend revisiting with real traffic data before
   inventing limits.*
4. **MFA / enterprise IdP** — out of scope by ADR-0013's own exclusions;
   the provider registry is the landing zone. *Existing recorded path.*
