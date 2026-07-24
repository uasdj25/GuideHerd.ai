# Microsoft Graph Calendar — Connection, Consent, and Permissions

**Status:** implemented against documented Microsoft Graph contracts
(GitLab #83); **live validation pending** the open Microsoft support
case — tracked as GitLab #95. Nothing in this document claims the live
integration is production-ready until #95 passes.

GuideHerd's native scheduling uses Microsoft Graph as its first calendar
provider behind the Calendar Provider Contract (ADR-0024). Customers and
operators interact with GuideHerd concepts ("connect your Microsoft
calendar", calendar bindings, tenant readiness) — never with Graph
mechanics.

## Application model

- **One Entra application registration** per GuideHerd deployment — the
  SAME registration already serving Graph mail (#60/#72). One app, one
  admin consent screen; permissions are granted per workload.
- **Client-credentials flow** (application permissions), scope
  `https://graph.microsoft.com/.default`, token endpoint
  `login.microsoftonline.com/{tenant}/oauth2/v2.0/token` — the pattern
  proven by the deployed mail adapter.
- Credentials by **environment reference only**: `MS_TENANT_ID`,
  `MS_CLIENT_ID`, `MS_CLIENT_SECRET`. Names appear in configuration and
  documentation; values exist only in the deployment environment /
  secret store. They are never written to the Configuration Store,
  repository, logs, telemetry, or error messages.

## Permission matrix

| Graph permission | Type | Why GuideHerd needs it | What breaks without it |
|---|---|---|---|
| `Calendars.ReadWrite` | Application | Read free/busy for bound attorney calendars (#85); create, update, and cancel appointment events (#86); read events back for reconciliation (#87) | All native scheduling: availability reads and event lifecycle both fail closed (`calendar_unavailable` / configuration family) |
| `User.Read.All` *(optional)* | Application | Calendar/mailbox discovery for binding UX (#84, #91): list schedulable mailboxes by display name | Discovery only — administrators fall back to entering a verified mailbox address by hand; scheduling itself is unaffected |
| `MailboxSettings.Read` *(optional)* | Application | Read a mailbox's working-hours/timezone settings as a future hours cross-check | Nothing in v1.0 — GuideHerd business hours are authoritative (location officeHours + booking-window policy) |

Deliberately **not** requested: `Calendars.Read` alone (insufficient for
booking), any delegated permission (no interactive user exists in the
caller flow), `Directory.Read.All` (broader than discovery needs).

## Least-privilege scoping (the restrictive default)

Application permissions are tenant-wide by default. GuideHerd's default
posture confines them with an **Exchange Online application access
policy** so the app can touch ONLY the firm's schedulable mailboxes:

```
New-DistributionGroup -Name "GuideHerd Schedulable" -Type Security
# add each schedulable attorney mailbox to the group, then:
New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> `
  -PolicyScopeGroupId "GuideHerd Schedulable" `
  -AccessRight RestrictAccess `
  -Description "GuideHerd may access only schedulable attorney calendars"
Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -Identity <attorney mailbox>
```

Consequences GuideHerd is built for: an out-of-policy mailbox fails
closed (`calendar_not_accessible` — a definitive refusal, never
ambiguity), and binding verification (#84) plus tenant readiness (#77)
surface it before a caller ever does.

## Tenant onboarding checklist (customer IT administrator)

1. Confirm the GuideHerd application registration (or create it for a
   dedicated deployment) and record the application (client) ID.
2. Grant **admin consent** for the permission matrix above
   (`https://login.microsoftonline.com/{tenant}/adminconsent?client_id={MS_CLIENT_ID}`).
3. Create the application access policy scoping GuideHerd to the
   schedulable-mailbox security group; run `Test-ApplicationAccessPolicy`
   for one in-scope and one out-of-scope mailbox and keep the output.
4. Supply the three credential values to the GuideHerd deployment
   environment (never by email; never into GuideHerd configuration
   screens — the Administration Portal shows presence only).
5. In GuideHerd: select the Microsoft provider for the tenant
   (`scheduling/calendar-targets.provider`), bind attorneys to their
   calendars (#84/#91), and confirm tenant readiness (#77) reports ready.

## Failure behavior (implemented, mock-tested)

| Condition | Behavior |
|---|---|
| Any credential absent | `configured: false`; every operation fails closed as configuration (503 family) with **zero** identity-provider calls |
| Consent revoked / app deleted / bad secret (token 400/401/403) | Fail closed as configuration; `provider.authentication_failed` telemetry; never retried automatically |
| Token endpoint 429/5xx/timeout/network | `calendar_unavailable` (transient); reads fail closed; write paths classify as **not attempted** (`phase: 'token'`) — definitive, never ambiguous |
| Token caching | Cached until 120 s before expiry; single-flight acquisition (concurrent operations share one request); a mid-operation 401 invalidates the cache for exactly one fresh acquisition |

## Assumptions requiring live confirmation (#95)

1. The granted `Calendars.ReadWrite` application permission authorizes
   `getSchedule`, event CRUD, and event queries against target mailboxes
   **under the application access policy** (Microsoft documents access
   policies as covering these workloads; the combination must be proven
   on the real tenant).
2. Real AADSTS error codes observed for revoked consent match the
   400/401/403 classification implemented here.
3. Discovery surface availability under the optional `User.Read.All`
   grant (#84).
4. Token lifetimes and throttling behavior of the production tenant.

Each is re-verified and dispositioned in #95 before any cutover step
(#96) may begin.
