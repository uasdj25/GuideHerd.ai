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
| F1 | Authentication | No rate limiting on `POST /api/v1/auth/login` — unbounded credential guessing | Medium | **FIXED** (#39): per-client fixed-window limiter (30/10 min), credential-blind 429, telemetered; explicit trusted-proxy model (F7); stale-window pruning (F8); process-local by design (one instance) with a durable-limiter follow-up recorded |
| F2 | Headers | API responses lacked `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS | Low-Med | **FIXED**: set on every JSON response and the one HTML endpoint |
| F3 | Headers | Product pages lacked CSP and frame protection (login surfaces frameable → clickjacking-shaped risk) | Low-Med | **FIXED**: `_headers` for Cloudflare Pages — global nosniff/DENY/no-referrer/HSTS; CSP on the three product surfaces (self-hosted everything + the one API origin; `'unsafe-inline'` required by the pages' inline-script architecture — external injection still blocked) |
| F4 | Probes | `/healthz`/`/readyz` answered GET only; platform checkers often use HEAD | Info | **FIXED**: HEAD supported, no body |
| F5 | Contract | #66's 200-slot cap exceeds the 16 KB body cap (~100 typical slots) | Info | **Documented** in the slot-selection contract; real availability is far below both bounds |
| F6 | Limiting | The login limiter trusted `x-forwarded-for` unconditionally and read the client-spoofable LEFTMOST entry | Med | **FIXED** (F7): trust is now explicit (`GUIDEHERD_TRUST_PROXY`, OFF by default → socket-only, spoof-proof); when on, the RIGHTMOST (edge-appended) entry is used, IPv6-normalized. Production behind Railway sets the flag |
| F7 | Limiting | (as F6 — the proxy-trust fix) | — | see F6 |
| F8 | Limiting | Limiter memory bound was clear-everything (a flood reset legit counters) | Low | **FIXED**: stale entries from past windows are pruned individually; a live counter is never discarded; a 50k hard backstop remains |
| F9 | Credential UI | #65's one-time issued credential stayed in the DOM after display (persisted through re-renders and other actions) | Med | **FIXED**: a Dismiss control and clear-on-next-action EMPTY the credential nodes (not just hide); browser-tested |
| F10 | Headers | CSP was declared in `_headers` but never proven to enforce or to spare required resources | Info | **FIXED**: a browser test applies the shipped CSP and proves all three surfaces load their own resources with zero violations AND that external script/stylesheet injection is blocked |

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
- **CSRF / cookies**: the `gh_session` cookie is `HttpOnly; Secure;
  SameSite=Strict; Path=/` and **host-only** (no `Domain`) — verified in the
  session suite. State-changing routes are POST/DELETE with JSON bodies
  (a cross-site form cannot send `application/json`), SameSite=Strict blocks
  the cookie on cross-site requests, and CORS returns
  `Access-Control-Allow-Credentials: true` **only** for exact-allowlisted
  origins — never `*` (wildcards dropped at parse; `corsHeadersFor` review).
  No cookie-authenticated GET has side effects.
- **CSP execution**: proven enforced, not merely present — a browser test
  (`tests/frontend/csp.test.js`) applies the shipped `_headers` CSP to all
  three product surfaces and asserts required resources load with zero
  violations while external script/stylesheet injection is blocked. The
  policy retains `'unsafe-inline'` for the pages' inline scripts (an
  architecture constraint; still blocks external injection and framing).
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

## Honest tiering

**Verified controls (evidence above):** authenticated operational APIs;
hash-keyed uniform bearer enforcement; audit of authorization denials +
every administration change + authentication events; secrets only in the
environment with digests at rest and an allowlisted telemetry surface;
session hardening (HttpOnly/Secure/SameSite=Strict/host-only, absolute
expiry, rotation, immediate revocation) now durable (#64); parameterized
SQL; structural PII stripping; login rate limiting with an explicit
trusted-proxy model; API security headers; enforced CSP; one-time
credential hygiene.

**Pilot-acceptable limitations (documented, single instance):** the login
limiter and alert-aggregation counters are process-local (reset on
restart, independent per instance) — correct for one instance; HSTS/CSP
depend on the Cloudflare edge; `GUIDEHERD_TRUST_PROXY` must be set in
production so per-client limiting works behind Railway's edge (unset →
whole-deployment throttle, which fails safe).

**Required before multi-instance scaling:** a durable/shared login limiter
(PG-backed, reusing the claim pattern); durable session store is already
done (#64). *These are the scaling trigger.*

**Required before a second customer / broader internet exposure:** durable
Operations alert history (#68 follow-up); general API rate limiting
informed by real traffic; a formal trusted-proxy hop model if the edge
topology changes.

**Deferred enterprise capabilities:** MFA / enterprise IdP (ADR-0013's
recorded provider-registry path).

## Follow-up recommendations (not created)

1. **Durable/global login limiter** — process-local is correct for the
   single-instance pilot; a shared limiter (PG-backed, reusing the claim
   pattern) should accompany any multi-instance move. *Pair the GitLab
   issue with the instance-scaling decision.*
2. **CSP without `'unsafe-inline'`** — requires externalizing the product
   pages' inline scripts (a build change contrary to the current
   no-build architecture). Current CSP already blocks external injection.
   *Recommend folding into any future front-end build/tooling decision.*
3. **General API rate limiting** (beyond login and the existing
   prepared-session cap) — the authenticated surface is session-gated and
   organization-scoped; the anonymous surface is the console pair already
   capped per firm. *Recommend revisiting with real traffic data before
   inventing limits.*
4. **Durable Operations alert history (#68 follow-up)** — raised/delivered/
   failed/recovered as durable, queryable states; reuse the ADR-0014
   outbox-feed upgrade, not a second monitoring system.
5. **MFA / enterprise IdP** — out of scope by ADR-0013's own exclusions;
   the provider registry is the landing zone. *Existing recorded path.*

Note on scope of the header fixes: HEAD support and the baseline security
headers are hygiene, not strong controls — they are recorded as such and
not inflated. The load-bearing browser protections are the enforced CSP
(F10) and the host-only SameSite=Strict cookie.
