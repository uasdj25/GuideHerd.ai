# Extension Points

Every seam below follows the same discipline (ADR-0007): a plain-object
contract, a registry that fails loudly on unknown keys (never a silent
substitute), registration at the composition root
(`server/handoff/app.js` — `createApp()`), and per-organization selection
through configuration. Capabilities that could surprise a customer ship
**dark by default**: registered on every deployment, active for no
organization until configuration names them. Extending the platform is one
implementation + one registration + configuration — zero Core changes.

Two recurring fail rules:

- **Fail loudly**: an explicitly configured but unregistered provider is a
  controlled error (503 / recorded `failed`), never a substitute. Malformed
  deployment configuration refuses to compose or boot.
- **Dark default**: an *unset* selection resolves to a safe default
  (`static-token`, `elevenlabs`, `graph-email`) or to "nothing happens"
  (integrations map empty, workflows list empty, reminders disabled).

## 1. User-authentication provider (`server/identity/user-auth.js`, ADR-0013)

Answers "do these login credentials identify a GuideHerd user, and who?"

```js
{
  providerKey: 'dev-user',
  // credentials is the OPAQUE login payload from POST /api/v1/auth/login
  // (today: { credential }). Returns an identity claim
  // ({ subject, type: 'user', displayName?, organizationKey, roles })
  // or throws an IdentityError subclass.
  authenticateUser(credentials) -> Promise<identity claim>
}
```

The claim passes the platform-wide validation in
`identity/contract.js:validateIdentityClaim()` — strict key allowlist, and
roles are *names* only; permissions come from the authorization policy
(ADR-0010). Reference implementation: `identity/dev-user-provider.js`
(SHA-256 credential digests; malformed `GUIDEHERD_DEV_USERS` refuses to
construct). Register in `app.js` next to
`userAuthProviders.register(createDevUserProvider(...))`. The **active**
provider is deployment config: `GUIDEHERD_USER_AUTH_PROVIDER` (default
`dev-user`, `resolveUserAuthProviderKey()`); an unregistered key fails loudly
at login (`IdentityProviderUnavailableError`).

## 2. Identity (service) provider (`server/identity/contract.js`, ADR-0009)

Authenticates service bearer tokens into a `GuideHerdIdentity`.

```js
{
  providerKey: 'static-token',
  // credentials: { bearerToken } — extracted by identity/middleware.js;
  // a provider never touches the HTTP request. Returns a claim WITHOUT
  // `provider` (provenance is stamped by the middleware). Throws
  // InvalidCredentialsError | IdentityNotConfiguredError.
  authenticate(credentials) -> Promise<identity claim>
}
```

Reference: `identity/static-token-provider.js`. Register in `app.js`
(`identityProviders.register(...)`). Selection is the `identity-provider`
configuration domain — setting `identity/provider`, default `static-token`
(`identity/provider-config.js`). Raw tokens are read in exactly one place
(`identity/middleware.js`) and never cross into Core, storage, events, or
logs; the claim's strict allowlist means a provider can never smuggle token
material or payloads into an identity.

## 3. Notification provider (`server/notifications/contract.js`, ADR-0011)

Delivers one rendered, branded customer message. Providers never decide
recipients, timing, content, branding, or workflow.

```js
{
  providerKey: 'graph-email',
  // Returns { status: 'sent'|'failed'|'not-configured', providerRequestId? }.
  // NEVER throws to Core; provider dialect errors are classified into the
  // GuideHerd taxonomy at this boundary and surface only as telemetry +
  // the neutral status.
  deliver({ rendered, recipient, branding }, context) -> Promise<result>
}
```

Register in `app.js` next to
`notificationProviders.register(createGraphEmailProvider({ telemetry }))`.
Selection: the `notification-provider` domain — setting
`notifications/provider`, default `graph-email` — with per-type overrides via
the `typeProviders` map passed to `createNotificationService()` (the
consultation summary routes to its mailer provider this way). The service
(`notifications/service.js`) claims the `notificationKey` **before** any
provider call (exactly-once per key, ever); a provider returning a status
outside the vocabulary is recorded `failed` — nonsense fails closed.

## 4. Integration provider (`server/integrations/contract.js`, ADR-0020)

Delivers one system-to-system effect. Requests carry per-type allowlisted
**safe identifier facts only** — never names, emails, phones, or free text;
the provider re-reads business truth from GuideHerd stores at delivery time.

```js
{
  providerKey: 'demo-integration',
  // Returns { status: 'completed'|'failed'|'not-configured', providerRequestId? }.
  // NEVER throws to Core; retry only what provably was NOT accepted
  // (duplication-safe classification, the mailer's discipline).
  deliver({ request }, context) -> Promise<result>
}
```

Register in `app.js` next to
`integrationProviders.register(createDemoIntegrationProvider({ telemetry }))`.
Selection is **per capability**: the `integration-providers` domain — setting
`integrations/providers`, value `{ providers: { '<type>': '<providerKey>' } }`
— maps each entry of `INTEGRATION_TYPES` to a provider. The default map is
empty (dark): an unmapped type is the controlled `not-configured` result. A
configured-but-unregistered provider is recorded `failed` (re-claimable, so
recovery delivers once the deployment registers it). Full walkthrough below.

## 5. Conversation adapter (`server/connect/adapter.js`, ADR-0005)

Translates one telephony/voice provider's dialect into GuideHerd's neutral
contracts. Adapters never transport audio and never normalize phone numbers
(the Correlation Engine, `connect/correlation.js`, does the matching).

```js
{
  providerKey: 'elevenlabs',
  // rawBody may be undefined; every intent field is optional:
  //   { sessionId?, callerPhone?, providerConversationId? }
  translateConnect(rawBody) -> ConnectIntent
  translateOutcome(rawBody) -> { sessionId, outcome }
}
```

Reference: `connect/elevenlabs-adapter.js`. Register in `app.js`
(`adapters.register(createElevenLabsAdapter())`). Selection: the
`conversation-provider` domain — setting `connect/conversation-provider`,
default `elevenlabs` (`connect/provider-config.js`); an explicitly configured
but unregistered provider is a loud 503
(`conversation_provider_unavailable`). Canonical outcome validation is shared
and can never be loosened per provider.

## 6. Scheduler action handler (`server/scheduler/scheduler.js`, ADR-0018)

```js
scheduler.register({ actionType: 'appointment-reminder', handle: async (action) => { ... } });
// producers:
await scheduler.schedule({
  actionKey,            // unique AND the dedupe key: '<actionType>:<entity>[:<qualifier>]'
  actionType, organizationKey,
  sessionId?, correlationId?,
  runAtMs,              // UTC ms — scheduling is always UTC
  expiresAtMs?,         // past this instant the action expires instead of running
  payload,              // small safe facts; never tokens, PII, provider payloads
});
```

Execution is at-least-once with bounded retries (default 5 attempts,
deterministic backoff); **handlers must be idempotent** — the reminder
handler (`scheduler/reminders.js`) is the model: it re-checks configuration
and re-reads the session at execution time, and its notification key equals
its action key so the customer effect stays exactly-once. Registering the
same `actionType` twice throws; an action whose type has no handler fails
into the bounded-retry path. Register from your feature module's
`register...()` function, called in `createApp()` (see
`registerAppointmentReminders({...})` in `app.js`).

## 7. Outbox consumer (`server/outbox/outbox.js`, ADR-0017)

```js
outbox.register({
  consumer: 'appointment-reminders',          // unique name; duplicate registration throws
  eventTypes: ['conversation.completed'],     // optional filter; others settle instantly
  handle: async (event) => { ... },           // event: { id, at, type, organizationKey,
});                                           //          sessionId, correlationId, payload }
```

Delivery is at-least-once per (event, consumer), with atomic claims, bounded
retries, stale-claim recovery, and consumer isolation (your failure never
blocks another consumer). Make effects idempotent — usually by keying them
through the notification/integration claim machines or the scheduler's
`actionKey` dedupe. Producers never change when you add a consumer.

## 8. Workflow definition (`server/workflow/contract.js`, ADR-0021)

A definition is code, never a DSL:

```js
{
  workflowType: 'demo-follow-up',   // kebab-case key
  version: 1,                       // positive integer; instances bind to it forever
  startsOn: { eventType, when?(event), instanceKeyOf(event) },
  reactsTo?: { [eventType]: instanceKeyOf },
  start(event) -> { state, stateData?, intents? },
  transition(state, signal, instance) -> null | { nextState, stateData?, intents? },
  terminalStates: ['completed'],
}
```

`transition()` is deterministic; returning `null` is the idempotent no-op.
Signals are platform machinery only: `{ kind: 'event', name, event }` and
`{ kind: 'timeout', name }`. `stateData` and intent facts are validated to
bounded scalars — identifiers, never customer snapshots. Intents run through
executors registered with `engine.registerIntentExecutor(name, execute)`;
composition wires `schedule-timeout`, `notify`, and (when the integration
service is composed) `integrate` (`workflow/executors.js`). Register and
**explicitly activate** in `app.js`:

```js
workflow.register(createDemoWorkflowDefinition());
workflow.activate('demo-follow-up', 1);   // registration alone never starts instances
```

Activation of an unregistered (type, version) throws — composition refuses to
assemble. Dark by default: instances start only for organizations whose
`workflows` domain lists the type in `enabledTypes`. Model:
`workflow/demo-workflow.js`.

## 9. Configuration domain (`server/configuration/framework.js`, ADR-0016)

```js
framework.register({
  id, title, owner,
  namespace, key,        // the Configuration Store setting address (unique)
  live: true, schemaVersion: 1,
  migrate?,              // (doc) -> doc, idempotent, applied on read and before write
  normalize,             // (raw, context) -> { value, issues }  — LENIENT: always
                         // yields a usable value; degradation stays in-domain
  validate?,             // (value, context) -> issues[]         — STRICT write-time rules
});
```

Consumers read with `readDomain(configService, id, organizationKey)` — never
throws for malformed content; defaults apply. Producers (the Administration
Framework is the only one today) call `validateDomain()` and persist **only**
the canonical normalized result. Production domains register in
`configuration/domains.js:registerProductionDomains()`; provider-selection
domains share the `providerSelectionDomain()` helper, and their strict rule
("provider must be registered on this deployment") runs when `app.js` passes
the registries via `validationContext()` to the Administration service.
Unknown domain ids fail loudly in both directions; duplicate ids or setting
addresses throw at registration.

---

## Worked walkthrough: a Clio-style integration provider, zero Core changes

Goal: route the existing `demo-record-sync` capability to a new provider,
`clio`. (Adding a *new capability* — a new entry in `INTEGRATION_TYPES` in
`integrations/contract.js` — is the one step that touches the contract file,
and by design arrives only with the workflow that needs it. Selecting a new
provider for an existing capability touches no Core file at all.)

**1. Implement the contract** — `server/integrations/clio-provider.js`,
modeled on `demo-provider.js`:

```js
'use strict';
const { withRetry } = require('../telemetry/retry');

function createClioIntegrationProvider({ telemetry, fetchImpl = fetch } = {}) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  return {
    providerKey: 'clio',
    async deliver({ request }, context = {}) {
      // request = { type, organizationKey, integrationKey, facts } — facts are
      // identifiers only; re-read business truth here if the effect needs it.
      try {
        await withRetry(async () => {
          const res = await fetchImpl(/* Clio API call built from request.facts */);
          if (!res.ok) {
            const err = new Error('clio rejected the request');
            err.category = res.status >= 500 ? 'transient_provider_failure' : 'permanent_provider_failure';
            // retryable ONLY when the effect provably was NOT accepted:
            err.retryable = res.status >= 500 && res.status !== 504;
            throw err;
          }
        }, { attempts: 3, onEvent: emit, fields: { component: 'internal', operation: 'integration-delivery', provider: 'clio', correlationId: context.correlationId, integrationKey: request.integrationKey } });
      } catch {
        return { status: 'failed' };       // never throw to Core
      }
      return { status: 'completed', providerRequestId: /* Clio's id */ undefined };
    },
  };
}
module.exports = { createClioIntegrationProvider };
```

Credentials come from the process environment inside the provider — never
from the Configuration Store (settings are exportable configuration).

**2. Register** — one line in `createApp()` (`server/handoff/app.js`), next
to the existing registration:

```js
integrationProviders.register(createDemoIntegrationProvider({ telemetry: tel }));
integrationProviders.register(createClioIntegrationProvider({ telemetry: tel }));
```

Registration alone changes nothing for any organization (dark by default).
The Administration write-validation context (`validationContext()` in
`app.js`) now automatically accepts `clio` as a valid provider key.

**3. Map the capability** — write the `integration-providers` domain for the
firm (through the Administration area, or a settings write validated by
`validateDomain('integration-providers', doc, context)`):

```json
{ "providers": { "demo-record-sync": "clio" } }
```

Per-capability selection means other types stay wherever they are mapped (or
unmapped ⇒ `not-configured`). From the next request,
`integrationService.request()` resolves `clio` for that type and delivers —
still exactly-once per `integrationKey` via the shared claim machine.

**4. Test it** — two layers, both existing patterns:

- The **delivery claim machine** is already covered by the shared suite
  (`integrations/delivery-contract-suite.js`, run against memory in
  `integrations/integrations.test.js` and against PostgreSQL in
  `operational/operational.test.js`) — you inherit it; nothing to write.
- **Provider + service tests** — `server/integrations/clio-provider.test.js`,
  mirroring the `makeService()` pattern in `integrations.test.js`: build a
  registry with your provider, an in-memory delivery store, a `fixedClock`,
  captured telemetry, and a config service whose `integrations/providers`
  setting maps `demo-record-sync` to `clio`; inject `fetchImpl` fakes. Assert:
  `deliver()` returns only the neutral statuses and never throws; a transient
  refusal retries and a permanent/ambiguous one does not (duplication
  safety); a second `service.request()` with the same `integrationKey` is
  `{ status: 'suppressed' }` with no provider call; telemetry lines carry
  only allowlisted fields (no facts, no payloads).

No change to `integrations/service.js`, the contract, the stores, the outbox,
or any route. That is the acceptance test of the seam itself: if your change
needs more than the provider file, one registration line, tests, and
configuration, stop and re-read ADR-0007.
