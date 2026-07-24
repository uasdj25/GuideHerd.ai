'use strict';

const { systemClock } = require('./clock');
const { createInMemoryHandoffStore } = require('./store');
const { createHandoffService } = require('./service');
const { normalizeCreate, normalizeRedeem } = require('./validation');
const { DEMO_FIRM_ID } = require('./demo-bridge');
const { selectOfferedSlots } = require('../scheduling/selection');
const { createCalcomAvailabilityProvider, clampTimeoutMs, AvailabilityError } = require('../scheduling/availability');
const { offerSlots, validateOfferedSlotsRequest } = require('../scheduling/offered-slots');
const { offerNativeSlots, nativeProviderKeyFor } = require('../scheduling/native-availability');
const { CalendarProviderError } = require('../scheduling/calendar-provider');
const { createInMemoryBookingContextStore, createInMemoryAuditLog } = require('../scheduling/booking-context-store');
const {
  createCalcomBookingProvider, clampBookingTimeoutMs, validateBookingRequest,
  bookAppointment, reconcileStaleBookingContexts,
} = require('../scheduling/booking');
const { buildConsultationSummary, renderSummaryHtml } = require('./summary');
const { NoCompletedSummaryError , TooManyLoginAttemptsError } = require('./errors');
const { createMailer } = require('./mailer');
const { HandoffError, MalformedRequestError, UnauthorizedError, BridgeNotConfiguredError, ValidationError } = require('./errors');
const { ConfigError } = require('../config/errors');
const { IdentityError, IdentityNotConfiguredError } = require('../identity/errors');
const { createIdentityProviderRegistry } = require('../identity/contract');
const { createStaticTokenProvider } = require('../identity/static-token-provider');
const { createIdentityService } = require('../identity/middleware');
const { createAuthorization } = require('../identity/authorization');
const { getSchedulingOptions } = require('../config/options');
const { ConnectError } = require('../connect/errors');
const { createAdapterRegistry } = require('../connect/adapter');
const { createElevenLabsAdapter } = require('../connect/elevenlabs-adapter');
const { createConversationService } = require('../connect/conversations');
const { createConversationEvents } = require('../connect/events');
const { resolveProviderKey } = require('../connect/provider-config');
const { callerMessageFor } = require('../connect/caller-messages');
const { createTelemetry, sanitizeError } = require('../telemetry/telemetry');
const { CORRELATION_HEADER, generateCorrelationId, extractCandidateCorrelationId } = require('../telemetry/correlation');
const { categorize } = require('../telemetry/taxonomy');
const { createNotificationProviderRegistry } = require('../notifications/contract');
const { createGraphEmailProvider } = require('../notifications/graph-email-provider');
const { createInMemoryNotificationDeliveryStore } = require('../notifications/delivery-store');
const { createNotificationService } = require('../notifications/service');
require('../notifications/alert-notification'); // registers the operational-alert renderer (#68)
const { createAlertingService } = require('../operations/alerting');
const { createRetentionService } = require('../operational/retention');
const { createIntegrationProviderRegistry, INTEGRATION_TYPES } = require('../integrations/contract');
const { createIntegrationService } = require('../integrations/service');
const { createInMemoryIntegrationDeliveryStore } = require('../integrations/delivery-store');
const { createDemoIntegrationProvider } = require('../integrations/demo-provider');
const { createWorkflowEngine } = require('../workflow/engine');
const { createInMemoryWorkflowStore } = require('../workflow/store');
const { registerStandardIntentExecutors } = require('../workflow/executors');
const { createDemoWorkflowDefinition } = require('../workflow/demo-workflow');
const { registerNotificationTriggers } = require('../notifications/triggers');
const {
  SUMMARY_TYPE, SUMMARY_PROVIDER_KEY,
  registerConsultationSummaryTemplate, createSummaryMailerProvider,
  createSummaryNotifier, registerSummaryRecovery,
} = require('../notifications/summary-notification');
const { createUserSessionService, SESSION_TOKEN_PREFIX } = require('../identity/user-sessions');
const { createUserAuthProviderRegistry, resolveUserAuthProviderKey } = require('../identity/user-auth');
const { createDevUserProvider } = require('../identity/dev-user-provider');
const { createUserDirectory } = require('../identity/user-directory');
const { DEFAULT_POLICY } = require('../identity/authorization');
const { UnauthenticatedError: SessionRequiredError, InvalidCredentialsError: SessionForbiddenError } = require('../identity/errors');
const { createOperationsCenter } = require('../operations/operations');
const { createAdministrationService } = require('../administration/service');
const { createOutbox, createInMemoryOutboxStore } = require('../outbox/outbox');
const { createScheduler, createInMemoryScheduledActionStore } = require('../scheduler/scheduler');
const { registerAppointmentReminders } = require('../scheduler/reminders');

// Scheduling context is tiny; cap the body to reject oversized payloads early.
const MAX_BODY_BYTES = 16 * 1024;

// Login attempt limiting (#39): fixed-window, per client address, counting
// ATTEMPTS (failures and floods look identical to a limiter, deliberately).
// Process-local: production runs one instance, and durable sessions (#64)
// did not change that; a shared/durable limiter is the recorded follow-up
// if the instance count ever grows. Memory is bounded by pruning stale
// (past-window) entries on each attempt — never by discarding live counters.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS_PER_WINDOW = 30;
const LOGIN_LIMITER_MAX_ENTRIES = 50_000; // hard backstop only; pruning keeps us far below
function createLoginLimiter({ clock, windowMs = LOGIN_WINDOW_MS, maxAttempts = LOGIN_MAX_ATTEMPTS_PER_WINDOW }) {
  const attempts = new Map(); // client -> { bucket, count }
  return {
    /** @returns {boolean} true when this attempt is allowed */
    attempt(client) {
      const bucket = Math.floor(clock.now() / windowMs);
      // Stale removal: drop every entry from a past window — bounds memory
      // to at most the distinct clients seen THIS window, and never resets
      // a live counter (unlike a clear-all). O(n) amortized; runs only when
      // the map is non-trivial.
      if (attempts.size >= 1024) {
        for (const [key, value] of attempts) {
          if (value.bucket < bucket) attempts.delete(key);
        }
      }
      // Absolute backstop against a single-window flood of distinct keys —
      // only reachable if XFF trust is on and the edge is not sanitizing.
      if (attempts.size > LOGIN_LIMITER_MAX_ENTRIES) return false;
      const current = attempts.get(client);
      const next = current && current.bucket === bucket
        ? { bucket, count: current.count + 1 }
        : { bucket, count: 1 };
      attempts.set(client, next);
      return next.count <= maxAttempts;
    },
  };
}

/**
 * Client address for limiting (#39). Trust of `X-Forwarded-For` is EXPLICIT
 * and OFF by default: an unconfigured or directly-exposed deployment uses
 * the socket peer only, so a client cannot spoof XFF to evade or forge a
 * limiter key. When `GUIDEHERD_TRUST_PROXY` is set (the deployment sits
 * behind a single trusted edge, e.g. Railway), the RIGHTMOST XFF entry is
 * used — the value the trusted proxy appended about its immediate peer,
 * which a client cannot control under the append model — never the
 * client-supplied leftmost. Normalized (lowercased, port/zone stripped,
 * length-capped) so IPv6 forms collapse to one key.
 */
function clientAddressOf(req, { trustProxy = false } = {}) {
  const normalize = (raw) => {
    let addr = String(raw || '').trim();
    const bracketed = addr.match(/^\[([^\]]+)\](?::\d+)?$/); // [v6] or [v6]:port
    if (bracketed) addr = bracketed[1];
    else if ((addr.match(/:/g) || []).length === 1) addr = addr.split(':')[0]; // v4:port
    addr = addr.replace(/%.*$/, ''); // IPv6 zone id
    return addr.toLowerCase().slice(0, 64) || 'unknown';
  };
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim() !== '') {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return normalize(parts[parts.length - 1]);
    }
  }
  return normalize(req.socket && req.socket.remoteAddress);
}

// Browser callers must be explicitly allowlisted. No wildcard is ever honored.
const DEFAULT_CORS_ALLOWED_ORIGINS = ['https://guideherd.ai', 'http://localhost:8080'];

/**
 * Parse a comma-separated origin allowlist (CORS_ALLOWED_ORIGINS). Wildcard
 * entries are dropped: this API never allows `*`.
 * @param {string|undefined} raw
 * @returns {Set<string>}
 */
function parseAllowedOrigins(raw) {
  const entries = (raw === undefined || raw.trim() === '')
    ? DEFAULT_CORS_ALLOWED_ORIGINS
    : raw.split(',');
  const origins = entries
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o !== '' && o !== '*');
  return new Set(origins);
}

/**
 * Compose the application (store + service + HTTP handler) with injectable
 * dependencies so tests can supply a deterministic clock, TTL, and origins.
 *
 * @param {{ clock?: import('./clock').Clock, ttlSeconds?: number, corsAllowedOrigins?: string,
 *           configService?: ReturnType<typeof import('../config/service').createConfigService> }} [deps]
 */
function createApp({ clock = systemClock(), ttlSeconds, corsAllowedOrigins, mailer, demoBridgeSecret, configService, configDb, handoffStore, staticIdentitiesJson, maxPreparedSessions, authorization, telemetry, notificationDeliveryStore, integrationDeliveryStore, workflowStore, consoleAuth, devUsersJson, userAuthProviderKey, userSessionTtlSeconds, outboxStore, scheduledActionStore, configurationAuthority, healthCheckTimeoutMs, userSessionStore, trustProxy, availabilityProvider, bookingContextStore, bookingProvider, calendarProviders, schedulingAudit } = {}) {
  // Configuration authority (ADR-0022): who owns configuration truth in this
  // deployment. server.js computes the real descriptor from the seed mode;
  // the default describes every other composition (tests, dev, demos), where
  // the store is written live and no boot-time seed runs.
  const configAuthority = configurationAuthority
    || { mode: 'live', seedOnBoot: false, lastBootImport: 'none' };
  // Operational Store (ADR-0006): the handoff repository is injectable. The
  // in-memory implementation remains the default; server.js selects the
  // durable PostgreSQL implementation via GUIDEHERD_OPERATIONAL_PROVIDER.
  // Operational telemetry (Issue #8): one centralized, allowlisted event
  // surface. Injectable so tests capture events instead of logging.
  const tel = telemetry || createTelemetry();
  // Operations feed observer (ADR-0014): wired once the Operations Center
  // exists below; the facade lets every earlier consumer share one
  // telemetry surface without ordering acrobatics.
  let opsObserver = () => {};
  let alertObserver = () => {};
  const observedTelemetry = {
    event(name, fields) {
      tel.event(name, fields);
      opsObserver(name, fields);
      alertObserver(name, fields);
    },
  };
  // Durable Event Outbox (ADR-0017): the repositories publish domain
  // events in the same transaction as the business change; consumers
  // process them via drain (post-commit nudge + boot recovery). server.js
  // supplies the PostgreSQL store; the in-memory pair is the default.
  const outboxEventStore = outboxStore || createInMemoryOutboxStore({ clock });
  const outbox = createOutbox({ store: outboxEventStore, clock, telemetry: observedTelemetry });
  // The GuideHerd Scheduler (ADR-0018): time-based business actions
  // behind the same drain()/claim reliability model as the outbox —
  // one liveness poller drives both (server.js).
  const schedulerStore = scheduledActionStore || createInMemoryScheduledActionStore({ clock });
  const scheduler = createScheduler({ store: schedulerStore, clock, telemetry: observedTelemetry });
  const store = handoffStore || createInMemoryHandoffStore({ clock, outbox: outboxEventStore });
  // Abuse containment for the deliberately-anonymous create route
  // (ADR-0010): cap concurrently prepared (awaiting-transfer, unexpired)
  // sessions per organization. Enforced ATOMICALLY inside the repository —
  // one synchronous pass in memory; a per-organization advisory
  // transaction lock in PostgreSQL — so concurrent creates across any
  // number of API instances can never overshoot the cap.
  const preparedSessionCap = maxPreparedSessions !== undefined
    ? maxPreparedSessions
    : Number(process.env.GUIDEHERD_MAX_PREPARED_SESSIONS || 20);
  const service = createHandoffService({ store, clock, ttlSeconds, maxPreparedSessions: preparedSessionCap });
  const allowedOrigins = parseAllowedOrigins(
    corsAllowedOrigins !== undefined ? corsAllowedOrigins : process.env.CORS_ALLOWED_ORIGINS,
  );
  // GuideHerd Connect: the provider-neutral conversation layer. The
  // registry holds one Conversation Adapter per provider; the active
  // provider per firm is resolved from the Configuration Store (defaulting
  // to elevenlabs, today's working integration).
  const adapters = createAdapterRegistry();
  adapters.register(createElevenLabsAdapter());
  const events = createConversationEvents();

  // GuideHerd Identity (ADR-0009): authentication happens ONLY through the
  // identity middleware and the provider selected by configuration. The
  // demo bridge secret is absorbed by the StaticTokenProvider as the
  // scheduling-assistant service identity — same credential, same external
  // behavior, but no route inspects it anymore. Malformed identity
  // configuration throws here: the app refuses to compose, never half-works.
  const resolvedBridgeSecret = demoBridgeSecret !== undefined ? demoBridgeSecret : process.env.DEMO_BRIDGE_SECRET;
  const identityProviders = createIdentityProviderRegistry();
  identityProviders.register(createStaticTokenProvider({
    staticIdentitiesJson: staticIdentitiesJson !== undefined ? staticIdentitiesJson : process.env.GUIDEHERD_STATIC_IDENTITIES,
    demoBridgeSecret: resolvedBridgeSecret,
  }));
  const identityService = createIdentityService({
    registry: identityProviders,
    configService: configService || null,
  });

  // GuideHerd User Sessions (ADR-0013): authentication providers establish
  // identity; GuideHerd establishes and owns the authenticated session.
  // Console enforcement is deployment configuration:
  //   GUIDEHERD_CONSOLE_AUTH = 'anonymous' (default — today's behavior) |
  //                            'required'  (anonymous console grants are
  //                                         withdrawn; sessions required)
  // An unknown value refuses to compose — never a silent default.
  const consoleAuthMode = (consoleAuth !== undefined ? consoleAuth : (process.env.GUIDEHERD_CONSOLE_AUTH || 'anonymous')).trim();
  if (!['anonymous', 'required'].includes(consoleAuthMode)) {
    throw new Error(`Unknown GUIDEHERD_CONSOLE_AUTH "${consoleAuthMode}" (expected "anonymous" or "required").`);
  }
  // GuideHerd User Directory (#65): the store-backed user source behind
  // the dev-user provider, managed live through the Administration
  // Framework. Requires the Configuration Store database (migration
  // 0003-users applies with the other config migrations); compositions
  // without one (some tests) simply have no directory — env-var
  // provisioning still works.
  const userDirectory = configDb ? createUserDirectory({ db: configDb, clock }) : null;
  const userAuthProviders = createUserAuthProviderRegistry();
  const devUserProvider = createDevUserProvider({
    devUsersJson: devUsersJson !== undefined ? devUsersJson : process.env.GUIDEHERD_DEV_USERS,
    userDirectory,
  });
  userAuthProviders.register(devUserProvider);
  const activeUserAuthProviderKey = userAuthProviderKey !== undefined
    ? userAuthProviderKey
    : resolveUserAuthProviderKey(process.env);
  // Durable login sessions (#64): server.js supplies the PostgreSQL
  // store under GUIDEHERD_OPERATIONAL_PROVIDER=postgres — the same switch
  // as every other durable store; the in-memory default is unchanged and
  // remains the reference.
  const rawUserSessions = createUserSessionService({
    store: userSessionStore,
    clock,
    ttlSeconds: userSessionTtlSeconds !== undefined
      ? userSessionTtlSeconds
      : Number(process.env.GUIDEHERD_USER_SESSION_TTL_SECONDS || 0) || undefined,
  });
  // Live directory overlay (#65): every session validation consults the
  // User Directory, so administration takes effect IMMEDIATELY —
  // deactivating a user kills their active sessions on the next request
  // (the stored session is invalidated, not just ignored), and role or
  // display-name changes apply without re-login. Users without a
  // directory record pass through unchanged. This is enforcement at
  // validation time, honoring the existing session store contract
  // (create/get/delete — no enumeration required).
  //
  // DEPLOYMENT WINS (#65 review): a deployment-provisioned (bootstrap)
  // identity is the recovery tier — deployment configuration outranks
  // database state, so the overlay NEVER applies to it. Without this, a
  // directory record sharing the bootstrap administrator's subject could
  // deactivate the deployment's own recovery path.
  const userSessions = {
    ...rawUserSessions,
    async validate(token) {
      const session = await rawUserSessions.validate(token);
      if (!session || !userDirectory) return session;
      const { organizationKey, subject } = session.identity;
      if (devUserProvider.isBootstrapSubject(organizationKey, subject)) return session;
      const record = userDirectory.get(organizationKey, subject);
      if (!record) return session;
      if (!record.active) {
        await rawUserSessions.invalidate(token);
        return null;
      }
      return {
        ...session,
        identity: {
          ...session.identity,
          roles: [...record.roles],
          displayName: record.displayName ?? session.identity.displayName,
        },
      };
    },
  };

  // GuideHerd Authorization (ADR-0010): the single decision point for "may
  // this principal perform this operation, in this organization, on this
  // resource?" Routes express GuideHerd permissions; the policy inside the
  // authorization service decides. Injectable only for tests. With console
  // authentication REQUIRED, the anonymous grants are withdrawn entirely —
  // fail closed; authenticated receptionists hold the console permissions.
  const activePolicy = consoleAuthMode === 'required'
    ? Object.freeze({ ...DEFAULT_POLICY, anonymous: Object.freeze([]) })
    : DEFAULT_POLICY;
  const authz = authorization || createAuthorization({ policy: activePolicy });

  // Trust X-Forwarded-For only when the deployment declares it sits behind
  // a trusted edge (#39). Off by default → socket-only, spoof-proof.
  const trustForwardedFor = trustProxy !== undefined
    ? Boolean(trustProxy)
    : ['1', 'true', 'yes'].includes(String(process.env.GUIDEHERD_TRUST_PROXY || '').trim().toLowerCase());
  const loginLimiter = createLoginLimiter({ clock });

  const deps = {
    service,
    store,
    clock,
    allowedOrigins,
    // Mailer is injectable so automated tests never touch Microsoft endpoints.
    mailer: mailer || createMailer({ telemetry: observedTelemetry }),
    // Configuration Store service (read-only use here). Optional: when
    // absent, configuration endpoints answer 503 rather than failing boot.
    configService: configService || null,
    adapters,
    identityService,
    authz,
    userSessions,
    userAuthProviders,
    activeUserAuthProviderKey,
    consoleAuthMode,
    loginLimiter,
    trustForwardedFor,
  };
  deps.telemetry = observedTelemetry;

  // Server-side availability: the offered-slots route fetches Cal.com
  // itself so the language model never transports slot batches.
  // Injectable so tests never touch Cal.com; the default reads
  // CALCOM_API_KEY from the environment and fails closed
  // (availability_not_configured) when absent. The provider timeout is
  // explicit and clamped to the interactive-voice range (default 1200 ms,
  // hard maximum 1500 ms) — GUIDEHERD_AVAILABILITY_TIMEOUT_MS overrides
  // within that range only.
  deps.availabilityProvider = availabilityProvider
    || createCalcomAvailabilityProvider({
      apiKey: process.env.CALCOM_API_KEY || null,
      timeoutMs: clampTimeoutMs(process.env.GUIDEHERD_AVAILABILITY_TIMEOUT_MS),
    });
  // Durable booking contexts (Issue #74 booking parity): the resolved
  // routing decision availability and booking share, claimable exactly
  // once. server.js supplies the PostgreSQL store under the postgres
  // operational provider; the in-memory reference is the default —
  // production booking correctness requires postgres, never process
  // memory. The booking provider shares CALCOM_API_KEY with availability
  // but has its own, longer timeout budget (a terminal action).
  deps.schedulingAudit = schedulingAudit || createInMemoryAuditLog();
  deps.bookingContexts = bookingContextStore
    || createInMemoryBookingContextStore({ clock, audit: deps.schedulingAudit });
  deps.bookingProvider = bookingProvider
    || createCalcomBookingProvider({
      apiKey: process.env.CALCOM_API_KEY || null,
      timeoutMs: clampBookingTimeoutMs(process.env.GUIDEHERD_BOOKING_TIMEOUT_MS),
    });
  // Native calendar providers (ADR-0024 registry, GitLab #80): keyed by
  // provider key, consulted only for tenants whose calendar-targets
  // domain selects one — with none registered (today's production), the
  // legacy path serves every tenant exactly as before.
  deps.calendarProviders = calendarProviders || {};
  // Policy-bypass detection: sessions that received a policy-governed
  // offered-slots response, pruned lazily. If an outcome reports BOOKED
  // for a prepared session that never got one, appointment times were
  // spoken from some other source — that must be loud, never silent.
  // DIAGNOSTIC ONLY: the map is in-process memory. It matches the
  // deployment's single-replica topology, but a restart empties it, so
  // a booking that spans a restart can warn falsely; it is a detector,
  // not enforcement. Durable enforcement would be an Operations Store
  // enhancement if multi-instance deployment ever becomes relevant.
  deps.offeredSlotsSessions = new Map();

  // GuideHerd Notifications (ADR-0011): Core owns notification intent;
  // providers only deliver. The delivery store makes every notification
  // exactly-once per notificationKey (in-memory default here; server.js
  // supplies the durable PostgreSQL store). The booked-confirmation
  // trigger is DISABLED BY DEFAULT per organization — see
  // notifications/triggers.js for why (external calendar attendee emails).
  //
  // The Consultation Summary is a first-class notification type (ADR-0011
  // §8): its template registers with the contract, its delivery rides the
  // existing Graph mailer boundary behind the provider contract, and the
  // conversation workflow only states an intent via the summary notifier.
  registerConsultationSummaryTemplate();
  const notificationProviders = createNotificationProviderRegistry();
  notificationProviders.register(createGraphEmailProvider({ telemetry: tel }));
  notificationProviders.register(createSummaryMailerProvider({ mailer: deps.mailer }));
  const notificationsDeliveryStore = notificationDeliveryStore || createInMemoryNotificationDeliveryStore({ clock });
  const notificationService = createNotificationService({
    registry: notificationProviders,
    deliveryStore: notificationsDeliveryStore,
    configService: configService || null,
    telemetry: observedTelemetry,
    typeProviders: { [SUMMARY_TYPE]: SUMMARY_PROVIDER_KEY },
  });
  registerNotificationTriggers({
    outbox,
    store,
    notificationService,
    configService: configService || null,
  });
  const summaryNotifier = createSummaryNotifier({ notificationService, telemetry: observedTelemetry });
  registerSummaryRecovery({ outbox, store, summaryNotifier });
  // Appointment reminders (ADR-0018): the outbox consumer schedules,
  // the scheduler executes, the Notification Contract delivers.
  // DISABLED BY DEFAULT per organization (appointment-reminders domain).
  registerAppointmentReminders({
    outbox, scheduler, store, notificationService,
    configService: configService || null, clock,
  });

  // The Integration Contract (ADR-0020): the system-to-system sibling of
  // the Notification Contract. The demonstration provider is registered on
  // every deployment (proving the extension seam) but the capability ships
  // DARK: no organization has a provider until the integration-provider
  // configuration domain names one. server.js supplies the PostgreSQL
  // delivery store; the in-memory reference is the default.
  const integrationProviders = createIntegrationProviderRegistry();
  integrationProviders.register(createDemoIntegrationProvider({ telemetry: tel }));
  const integrationsDeliveryStore = integrationDeliveryStore || createInMemoryIntegrationDeliveryStore({ clock });
  const integrationService = createIntegrationService({
    registry: integrationProviders,
    deliveryStore: integrationsDeliveryStore,
    configService: configService || null,
    telemetry: observedTelemetry,
  });

  // The Workflow Contract (ADR-0021): durable multi-step business
  // processes composing the platform's existing signals and intents. The
  // engine registers ONE outbox consumer and ONE scheduler action type
  // through their public seams — those contracts remain unaware of
  // workflows. The demonstration definition ships DARK: no organization
  // runs it until the `workflows` configuration domain enables it.
  // server.js supplies the PostgreSQL store; the in-memory reference is
  // the default. Intent executors are wired here because composition is
  // the one place that knows which services exist; the `integrate`
  // executor rides along only because THIS deployment composes the
  // Integration Contract — the engine and every definition work without
  // it.
  const workflowInstanceStore = workflowStore || createInMemoryWorkflowStore({ clock });
  const workflow = createWorkflowEngine({
    store: workflowInstanceStore,
    outbox,
    scheduler,
    configService: configService || null,
    clock,
    telemetry: observedTelemetry,
  });
  workflow.register(createDemoWorkflowDefinition());
  // Version activation is EXPLICIT (ADR-0021): registering a definition
  // never selects it for new instances; this deliberate activation does.
  workflow.activate('demo-follow-up', 1);
  registerStandardIntentExecutors({
    engine: workflow,
    scheduler,
    notificationService,
    handoffStore: store,
    integrationService,
    configService: configService || null,
    clock,
  });
  workflow.attach();

  deps.conversations = createConversationService({
    service, store, summaryNotifier, events, clock, telemetry: observedTelemetry,
  });

  // GuideHerd Operations Center (ADR-0014): operational visibility over
  // existing stores and events — nothing duplicated. The telemetry
  // emitter is wrapped so every operational event is also observed by the
  // ops feed, and Connect conversation events join the same feed; both
  // pass the telemetry field allowlist before they can be displayed.
  const operations = createOperationsCenter({
    store,
    notificationDeliveryStore: notificationsDeliveryStore,
    outboxStore: outboxEventStore,
    configService: configService || null,
    clock,
    healthCheckTimeoutMs,
    capabilities: [
      {
        capability: 'notification-provider',
        check: () => {
          const provider = notificationProviders.resolve('graph-email');
          return provider.enabled ? 'available' : 'not-configured';
        },
      },
      // Booking runs provider-side today (ADR-0011 §7); honest status
      // until the first Scheduling extension lands (ADR-0012 §5).
      { capability: 'scheduling-provider', check: () => 'not-integrated' },
      {
        // The deployment CAN perform integrations when providers are
        // registered; per-organization enablement is configuration
        // (ADR-0020 — dark by default).
        capability: 'integration-provider',
        check: () => (integrationProviders.keys().length > 0 ? 'available' : 'not-configured'),
      },
      {
        // The deployment CAN run workflows when definitions are
        // registered; per-organization enablement is configuration
        // (ADR-0021 — dark by default).
        capability: 'workflow-engine',
        check: () => (workflow.registry.types().length > 0 ? 'available' : 'not-configured'),
      },
      {
        capability: 'user-authentication',
        check: () => {
          const provider = userAuthProviders.resolve(activeUserAuthProviderKey);
          return typeof provider.size === 'function'
            ? (provider.size() > 0 ? 'available' : 'not-configured')
            : 'available';
        },
      },
      {
        capability: 'service-identity',
        check: () => {
          const provider = identityProviders.resolve('static-token');
          return provider.size() > 0 ? 'available' : 'not-configured';
        },
      },
      {
        // Who owns configuration truth (ADR-0022): `live` = the store,
        // written through Administration, is authoritative; `seed-managed`
        // = an explicit recurring re-import overwrites it at every boot.
        capability: 'configuration-authority',
        check: () => configAuthority.mode,
      },
      {
        // Failure alerting (#68): available once at least one
        // organization enabled it with a recipient; dark by default.
        capability: 'failure-alerting',
        check: () => {
          if (!configService) return 'not-configured';
          const { readDomain } = require('../configuration/framework');
          const anyEnabled = configService.organizations.list().some((o) => {
            const { value } = readDomain(configService, 'operational-alerts', o.key);
            return value && value.enabled && value.recipient;
          });
          return anyEnabled ? 'available' : 'not-configured';
        },
      },
      {
        // Data retention (#63): DARK BY DEFAULT — `not-configured` means the
        // purge deletes NOTHING for any organization. Flips to `available`
        // only when a firm explicitly enables retention (opt-in).
        capability: 'data-retention',
        check: () => {
          if (!configService) return 'not-configured';
          const { readDomain } = require('../configuration/framework');
          const anyEnabled = configService.organizations.list().some((o) => {
            const { value } = readDomain(configService, 'data-retention', o.key);
            return value && value.enabled === true;
          });
          return anyEnabled ? 'available' : 'not-configured';
        },
      },
    ],
  });
  opsObserver = (name, fields) => operations.observe(name, fields);
  deps.operations = operations;

  // Failure alerting (#68): conditions observed from existing seams; the
  // alert itself is an ordinary notification, so the claim machine makes
  // one-alert-per-condition-window structural. Loud telemetry always —
  // an alert about the mail system never depends on the mail system.
  const alerting = createAlertingService({
    notifications: notificationService,
    configService: configService || null,
    clock,
    telemetry: observedTelemetry,
    healthReport: () => operations.healthReport(),
  });
  outbox.register(alerting.outboxConsumer());
  alertObserver = (name, fields) => alerting.observe(name, fields);
  deps.alerting = alerting;

  // Data retention (ADR-0006 / #63): the automated purge, driven by the
  // liveness poller (server.js) — deterministic, idempotent, org-scoped.
  const retention = createRetentionService({
    store, configService: configService || null, clock, telemetry: observedTelemetry,
  });
  deps.retention = retention;

  // GuideHerd Administration (ADR-0015): one producer over the same
  // Configuration Store every subsystem consumes — validated, versioned,
  // audited. Requires the store AND its database (for the audit ledger);
  // absent either, administration answers 503 rather than half-working.
  const administration = (configService && configDb)
    ? createAdministrationService({
        configService,
        configDb,
        clock,
        telemetry: observedTelemetry,
        identityProviderKeys: () => userAuthProviders.keys(),
        // Surfaced in describe() so the Administration screen can state
        // whether its own writes are authoritative (ADR-0022).
        configurationAuthority: () => configAuthority,
        // User management (#65): the directory the users area writes, and
        // the closed role vocabulary it may assign — exactly the policy's
        // roles (ADR-0010); administration can never widen it. Bootstrap
        // identities are deployment-owned and cannot be shadowed.
        userDirectory,
        assignableRoles: () => Object.keys(activePolicy.roles),
        isBootstrapSubject: (org, subject) => devUserProvider.isBootstrapSubject(org, subject),
        // The full write-validation context (ADR-0016): every provider
        // registry this composition holds, so configured-but-unregistered
        // selections are rejected at ADMINISTRATION time — runtime
        // resolution remains loud as defense in depth.
        validationContext: () => ({
          identityProviderKeys: userAuthProviders.keys(),
          conversationProviderKeys: adapters.keys(),
          notificationProviderKeys: notificationProviders.keys(),
          integrationProviderKeys: integrationProviders.keys(),
          integrationTypes: Object.keys(INTEGRATION_TYPES),
          workflowTypes: workflow.registry.types(),
        }),
      })
    : null;
  deps.administration = administration;
  // Conversation lifecycle reaches the operations feed DURABLY through
  // the outbox (ADR-0017) — the previous ephemeral observers are gone;
  // restart survival follows for free.
  events.on('conversation.completed', () => outbox.drainSoon());
  events.on('conversation.connected', () => outbox.drainSoon());
  const handler = makeHandler(deps);
  return {
    handler, store, service, clock, allowedOrigins, alerting, retention,
    // DIAGNOSTIC visibility only (tests, operations): the in-memory
    // bypass-detection bookkeeping. Never authoritative enforcement.
    diagnostics: { offeredSlotsSessions: deps.offeredSlotsSessions },
    // Booking-context store + boot reconciliation (server.js calls this
    // next to the outbox drain: stranded booking_in_progress rows flip
    // loudly to verification_required after a crash or redeploy).
    bookingContexts: deps.bookingContexts,
    // The append-only scheduling audit sink (in-memory by default; the
    // durable PostgreSQL sink under the postgres operational provider).
    schedulingAudit: deps.schedulingAudit,
    reconcileBookingContexts: async () => {
      try {
        return await reconcileStaleBookingContexts({
          bookingContexts: deps.bookingContexts, telemetry: observedTelemetry,
        });
      } catch (err) {
        // A reconciliation failure is NEVER silent: the store threw, so
        // stranded rows may still await an operator. Identifiers and the
        // sanitized error only — no contexts, hashes, or payloads.
        observedTelemetry.event('internal.unexpected_error', {
          severity: 'error', component: 'scheduling',
          operation: 'booking-reconciliation', ...sanitizeError(err),
        });
        return [];
      }
    },
    mailer: deps.mailer, events, adapters, conversations: deps.conversations,
    identity: { registry: identityProviders, service: identityService },
    authorization: authz,
    telemetry: tel,
    notifications: {
      registry: notificationProviders,
      service: notificationService,
      deliveryStore: notificationsDeliveryStore,
    },
    integrations: {
      registry: integrationProviders,
      service: integrationService,
      deliveryStore: integrationsDeliveryStore,
    },
    workflow,
    users: {
      registry: userAuthProviders,
      sessions: userSessions,
      consoleAuthMode,
    },
    operations,
    administration,
    outbox,
    scheduler,
  };
}

/**
 * CORS response headers for a request, or null when the Origin is absent or
 * not allowlisted (no CORS headers → the browser blocks the response).
 * @param {import('node:http').IncomingMessage} req
 * @param {Set<string>} allowedOrigins
 */
function corsHeadersFor(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin.replace(/\/$/, ''))) {
    return null;
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'X-GuideHerd-Correlation-Id',
    'Vary': 'Origin',
  };
}

/** Build the raw Node http request handler. */
function makeHandler({ service, store, clock, allowedOrigins, mailer, configService, adapters, conversations, identityService, authz, telemetry, userSessions, userAuthProviders, activeUserAuthProviderKey, consoleAuthMode, operations, administration, loginLimiter, trustForwardedFor, availabilityProvider, offeredSlotsSessions, bookingContexts, bookingProvider, calendarProviders }) {
  /**
   * Resolve the active Conversation Adapter for a firm. Provider selection
   * comes from the Configuration Store (connect/conversation-provider),
   * defaulting to today's integration when unset; an explicitly configured
   * but unregistered provider fails loudly (503).
   */
  const adapterFor = (firmId) => adapters.resolve(resolveProviderKey(configService, firmId));

  /**
   * Authenticate a demo-bridge request through the Identity Contract and
   * authorize the named GuideHerd permission for the demo organization
   * (ADR-0010): the route states its intent; the policy decides. Routes
   * never see the bearer token — only the resulting GuideHerdIdentity.
   *
   * TEMPORARY DEMO INFRASTRUCTURE dialect: the bridge's documented
   * "not configured" error code predates the Identity Contract and is
   * preserved verbatim while the bridge exists; the mapping dies with it.
   */
  const authorizeAssistant = async (req, permission) => {
    let identity;
    try {
      identity = await identityService.authenticate(req, { organizationKey: DEMO_FIRM_ID });
    } catch (err) {
      if (err instanceof IdentityNotConfiguredError) throw new BridgeNotConfiguredError();
      throw err;
    }
    authz.authorize({ identity }, permission, {
      organizationKey: DEMO_FIRM_ID,
      auditSuccess: true, // privileged, low-frequency service operations
    });
    return identity;
  };

  /**
   * Tenant-generic variant for reusable scheduling routes: authenticate,
   * then authorize the permission against the IDENTITY'S OWN
   * organization — never a pinned demo organization. Cross-tenant access
   * is impossible by construction (the authorization target IS the
   * identity's organization), and an identity without an organization is
   * returned unauthorized-to-any-tenant for the route to refuse with a
   * typed failure.
   */
  const authorizeTenantAssistant = async (req, permission) => {
    let identity;
    try {
      identity = await identityService.authenticate(req, {});
    } catch (err) {
      if (err instanceof IdentityNotConfiguredError) throw new BridgeNotConfiguredError();
      throw err;
    }
    if (!identity.organizationKey) return { identity, organizationKey: null };
    authz.authorize({ identity }, permission, {
      organizationKey: identity.organizationKey,
      auditSuccess: true,
    });
    return { identity, organizationKey: identity.organizationKey };
  };

  /** Cookie parsing (no dependencies; values are opaque tokens only). */
  const parseCookies = (req) => {
    const header = req.headers.cookie;
    const cookies = {};
    if (typeof header !== 'string') return cookies;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return cookies;
  };
  const SESSION_COOKIE = 'gh_session';
  const sessionCookieValue = (token, maxAgeSeconds) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;

  return async function handle(req, res) {
    const startedAt = Date.now();
    let status = 500;
    let sessionId; // captured for logging only — never a token or secret
    // One GuideHerd correlation ID per request (Issue #8): ALWAYS freshly
    // generated here. A caller-supplied ID is only a CANDIDATE — it is
    // adopted below solely after the request authenticates as a trusted
    // GuideHerd service identity (never for anonymous, browser, or
    // capability-token requests: arbitrary callers must not control
    // operational log identifiers). The active ID appears in logs, error
    // envelopes, downstream context, and the response header — and is
    // never a token, phone number, email address, or caller name.
    let correlationId = generateCorrelationId();
    const suppliedCorrelationId = extractCandidateCorrelationId(req.headers[CORRELATION_HEADER]);
    /** Adopt the supplied candidate once a GuideHerd SERVICE identity has authenticated. */
    const adoptSuppliedCorrelation = (identity) => {
      if (suppliedCorrelationId && identity && identity.type === 'service') {
        correlationId = suppliedCorrelationId;
      }
    };
    // GuideHerd user session (ADR-0013): the HttpOnly cookie, validated
    // server-side into a GuideHerdIdentity. Browser-supplied organization
    // or role information never exists — everything comes from the
    // server-held session record.
    const presentedSessionToken = parseCookies(req)[SESSION_COOKIE];
    /**
     * The principal for browser-facing console operations: the
     * authenticated user session when present; otherwise anonymous — and
     * with console authentication REQUIRED, no session is a 401, so an
     * unauthenticated browser never even reaches an authorization denial.
     */
    const consolePrincipal = async () => {
      const session = await userSessions.validate(presentedSessionToken);
      if (session) return { identity: session.identity };
      if (consoleAuthMode === 'required') throw new SessionRequiredError();
      return { anonymous: true };
    };
    // Demo bridge endpoints are server-to-server only: they are never
    // granted browser CORS headers, regardless of Origin.
    const isDemoPath = typeof req.url === 'string' && req.url.startsWith('/api/v1/demo/');
    const cors = isDemoPath ? null : corsHeadersFor(req, allowedOrigins);

    try {
      const method = req.method;
      // Parse path only; tokens are never read from the query string.
      const path = new URL(req.url, 'http://localhost').pathname;

      // Preflight. Allowed: POST/GET/DELETE (+ OPTIONS), Content-Type and Authorization.
      if (method === 'OPTIONS') {
        status = 204;
        const headers = cors
          ? {
              ...cors,
              'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GuideHerd-Correlation-Id',
              'Access-Control-Max-Age': '600',
            }
          : { 'Vary': 'Origin' };
        headers['X-GuideHerd-Correlation-Id'] = correlationId;
        res.writeHead(status, headers);
        return res.end();
      }

      // ── Public health probes (#38) ──────────────────────────────────
      // Liveness: constant-time, zero-information, checks NOTHING — a
      // liveness probe that consults dependencies turns a database blip
      // into a restart storm. Readiness: one bounded boolean over the
      // required stores; no capability names or detail ever leave these
      // routes. The authenticated detail surface remains ADR-0014's
      // /api/v1/operations/health.
      if ((method === 'GET' || method === 'HEAD') && path === '/healthz') {
        status = 200;
        if (method === 'HEAD') { res.writeHead(status); return res.end(); }
        return sendJson(res, status, { status: 'ok' }, cors, correlationId);
      }
      if ((method === 'GET' || method === 'HEAD') && path === '/readyz') {
        const ready = await operations.ready();
        status = ready ? 200 : 503;
        if (method === 'HEAD') { res.writeHead(status); return res.end(); }
        return sendJson(res, status, { status: ready ? 'ready' : 'unavailable' }, cors, correlationId);
      }

      // ── GuideHerd Administration (ADR-0015) ─────────────────────────
      // Always session-authenticated; reads require administration:read,
      // changes require administration:write. The organization and actor
      // come exclusively from the server-held session — administration is
      // organization-scoped by construction, and cross-organization
      // administration is structurally impossible.
      if (path.startsWith('/api/v1/admin/')) {
        const session = await userSessions.validate(presentedSessionToken);
        if (!session) throw new SessionRequiredError();
        if (!administration) {
          status = 503;
          return sendJson(res, status, {
            error: { code: 'config_unavailable', message: 'The configuration store is not available.', correlationId },
          }, cors, correlationId);
        }
        const identity = session.identity;
        const org = identity.organizationKey;
        const url = new URL(req.url, 'http://localhost');

        if (method === 'GET' && path === '/api/v1/admin/configuration') {
          authz.authorize({ identity }, 'administration:read', { organizationKey: org });
          status = 200;
          return sendJson(res, status, administration.describe(org), cors, correlationId);
        }
        if (method === 'GET' && path === '/api/v1/admin/audit') {
          authz.authorize({ identity }, 'administration:read', { organizationKey: org });
          status = 200;
          return sendJson(res, status, {
            audit: administration.audit(org, {
              entity: url.searchParams.get('entity') || undefined,
              limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200),
            }),
          }, cors, correlationId);
        }
        const areaMatch = path.match(/^\/api\/v1\/admin\/([a-z][a-z-]*)$/);
        if (method === 'POST' && areaMatch) {
          authz.authorize({ identity }, 'administration:write', {
            organizationKey: org,
            auditSuccess: true, // configuration changes are always audited
          });
          const body = await readJsonBody(req);
          const outcome = administration.apply(
            decodeURIComponent(areaMatch[1]),
            { actor: identity.subject, organizationKey: org },
            body.payload,
            body.expectedVersion,
          );
          status = 200;
          return sendJson(res, status, outcome, cors, correlationId);
        }
        status = 404;
        return sendJson(res, status, { error: { code: 'not_found', message: 'Resource not found.', correlationId } }, cors, correlationId);
      }

      // ── GuideHerd Operations Center (ADR-0014) ──────────────────────
      // Read-only operational visibility. ALWAYS session-authenticated
      // (never anonymous, regardless of the console floor) and authorized
      // for operations:read; every query is scoped to the operator's own
      // organization from the server-held session — never from input.
      if (method === 'GET' && path.startsWith('/api/v1/operations/')) {
        const session = await userSessions.validate(presentedSessionToken);
        if (!session) throw new SessionRequiredError();
        const identity = session.identity;
        authz.authorize({ identity }, 'operations:read', { organizationKey: identity.organizationKey });
        const org = identity.organizationKey;
        const url = new URL(req.url, 'http://localhost');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);

        if (path === '/api/v1/operations/overview') {
          status = 200;
          return sendJson(res, status, await operations.overview(org), cors, correlationId);
        }
        if (path === '/api/v1/operations/sessions') {
          const group = url.searchParams.get('group') || undefined;
          status = 200;
          return sendJson(res, status, { sessions: await operations.sessions(org, { group, limit }) }, cors, correlationId);
        }
        if (path === '/api/v1/operations/notifications') {
          const failedOnly = url.searchParams.get('failed') === 'true';
          status = 200;
          return sendJson(res, status, { notifications: await operations.notifications(org, { limit, failedOnly }) }, cors, correlationId);
        }
        if (path === '/api/v1/operations/events') {
          const eventsCorrelation = url.searchParams.get('correlationId') || undefined;
          status = 200;
          return sendJson(res, status, { events: await operations.events(org, { correlationId: eventsCorrelation, limit }) }, cors, correlationId);
        }
        if (path === '/api/v1/operations/errors') {
          status = 200;
          return sendJson(res, status, { events: await operations.recentErrors(org, { limit }) }, cors, correlationId);
        }
        if (path === '/api/v1/operations/health') {
          status = 200;
          // Full report (#38): overall rollup + per-capability list. The
          // `health` array keeps its pre-#38 shape; status/checkedAt are
          // additive.
          return sendJson(res, status, await operations.healthReport(), cors, correlationId);
        }
        const timelineMatch = path.match(/^\/api\/v1\/operations\/timeline\/([^/]+)$/);
        if (timelineMatch) {
          status = 200;
          return sendJson(res, status, await operations.timeline(org, decodeURIComponent(timelineMatch[1])), cors, correlationId);
        }
        if (path === '/api/v1/operations/search') {
          status = 200;
          return sendJson(res, status, await operations.search(org, url.searchParams.get('q') || ''), cors, correlationId);
        }
        status = 404;
        return sendJson(res, status, { error: { code: 'not_found', message: 'Resource not found.' } }, cors, correlationId);
      }

      // ── GuideHerd user authentication (ADR-0013) ────────────────────
      // Login: the configured User Authentication Provider turns the
      // opaque credential into an identity claim; GuideHerd validates the
      // claim, verifies organization membership, and establishes ITS OWN
      // session (fresh token, HttpOnly cookie — rotation invalidates any
      // session presented with the login request). Provider tokens and
      // claims never reach the browser.
      if (method === 'POST' && path === '/api/v1/auth/login') {
        // Bounded attempts BEFORE any credential work (#39): the limiter
        // answers 429 uniformly and confirms nothing about credentials.
        if (loginLimiter && !loginLimiter.attempt(clientAddressOf(req, { trustProxy: trustForwardedFor }))) {
          telemetry.event('authentication.login_failed', {
            severity: 'warn', component: 'identity', operation: 'login',
            correlationId, code: 'rate_limited',
          });
          throw new TooManyLoginAttemptsError();
        }
        const body = await readJsonBody(req);
        const credential = body && typeof body.credential === 'string' ? body.credential.trim() : '';
        if (credential === '' || credential.length > 512) {
          throw new ValidationError('One or more fields are invalid.', [
            { field: 'credential', message: 'is required' },
          ]);
        }
        let claim;
        try {
          const provider = userAuthProviders.resolve(activeUserAuthProviderKey); // loud 503 on misconfiguration
          claim = await provider.authenticateUser({ credential });
          // Organization membership is GuideHerd's to validate — an
          // identity claiming an organization the platform does not know
          // is refused, regardless of what the provider asserted.
          if (configService) configService.organizations.get(claim.organizationKey); // throws on unknown org
        } catch (err) {
          telemetry.event('authentication.login_failed', {
            severity: 'warn',
            component: 'identity',
            operation: 'login',
            provider: activeUserAuthProviderKey,
            correlationId,
            code: err && err.code ? err.code : 'invalid_credentials',
          });
          if (err instanceof IdentityError) throw err;
          throw new SessionForbiddenError();
        }
        const { token, identity, expiresAtMs } = await userSessions.establish(
          claim, activeUserAuthProviderKey, { presentedToken: presentedSessionToken },
        );
        telemetry.event('authentication.login', {
          severity: 'info',
          component: 'identity',
          operation: 'login',
          provider: activeUserAuthProviderKey,
          subject: identity.subject,
          organizationKey: identity.organizationKey,
          correlationId,
        });
        res.setHeader('Set-Cookie', sessionCookieValue(token, userSessions.ttlSeconds));
        status = 200;
        return sendJson(res, status, {
          subject: identity.subject,
          displayName: identity.displayName,
          organizationKey: identity.organizationKey,
          roles: identity.roles,
          expiresAt: new Date(expiresAtMs).toISOString(),
        }, cors, correlationId);
      }

      // Logout: server-side invalidation plus cookie clearance. Always
      // succeeds — logging out twice is not an error.
      if (method === 'POST' && path === '/api/v1/auth/logout') {
        const session = await userSessions.validate(presentedSessionToken);
        await userSessions.invalidate(presentedSessionToken);
        if (session) {
          telemetry.event('authentication.logout', {
            severity: 'info',
            component: 'identity',
            operation: 'logout',
            subject: session.identity.subject,
            organizationKey: session.identity.organizationKey,
            correlationId,
          });
        }
        res.setHeader('Set-Cookie', sessionCookieValue('', 0));
        status = 204;
        res.writeHead(status, { 'Cache-Control': 'no-store', 'X-GuideHerd-Correlation-Id': correlationId, ...(cors || {}) });
        return res.end();
      }

      // Current session (console bootstrapping): who am I, if anyone?
      if (method === 'GET' && path === '/api/v1/auth/session') {
        const session = await userSessions.validate(presentedSessionToken);
        if (!session) throw new SessionRequiredError();
        status = 200;
        return sendJson(res, status, {
          subject: session.identity.subject,
          displayName: session.identity.displayName,
          organizationKey: session.identity.organizationKey,
          roles: session.identity.roles,
          expiresAt: new Date(session.expiresAtMs).toISOString(),
        }, cors, correlationId);
      }

      // Scheduling options for the GuideHerd Console: the firm's practice
      // areas and, per practice area, the attorneys its routing groups reach.
      // Read-only, browser-facing (same CORS posture as the handoff routes),
      // and served from the Configuration Store.
      const optionsMatch = path.match(/^\/api\/v1\/firms\/([^/]+)\/scheduling-options$/);
      if (optionsMatch && method === 'GET') {
        if (!configService) {
          status = 503;
          return sendJson(res, status, {
            error: { code: 'config_unavailable', message: 'The configuration store is not available.' },
          }, cors, correlationId);
        }
        const firmId = decodeURIComponent(optionsMatch[1]);
        // With console authentication enabled, an authenticated
        // receptionist (organization-scoped) reads their firm's options;
        // otherwise the explicit anonymous grant applies (ADR-0010/0013).
        authz.authorize(await consolePrincipal(), 'configuration:read', { organizationKey: firmId });
        const options = getSchedulingOptions(configService, firmId);
        status = 200;
        return sendJson(res, status, options, cors, correlationId);
      }

      if (method === 'POST' && path === '/api/v1/handoffs') {
        const body = await readJsonBody(req);
        const request = normalizeCreate(body);
        // Session-aware (ADR-0013): an authenticated receptionist creates
        // handoffs only within their own organization (the org in the body
        // is untrusted input checked against the server-held session);
        // anonymously only while the explicit anonymous grant remains.
        // The per-organization prepared-session cap is enforced ATOMICALLY
        // inside the repository via service.create (429 when full).
        authz.authorize(await consolePrincipal(), 'handoff:create', { organizationKey: request.firmId });
        const { response } = await service.create(request);
        sessionId = response.sessionId;
        status = 201;
        return sendJson(res, status, response, cors, correlationId);
      }

      if (method === 'POST' && path === '/api/v1/handoffs/redeem') {
        const body = await readJsonBody(req);
        const { handoffToken } = normalizeRedeem(body);
        const context = await service.redeem(handoffToken, { correlationId }); // repository verifies the capability credential
        // Capability authorization (ADR-0010): a handoff token may redeem
        // exactly its own session, and nothing else.
        authz.authorize(
          { capability: { type: 'handoff-token', sessionId: context.sessionId } },
          'handoff:redeem',
          { resource: { type: 'handoff-session', id: context.sessionId } },
        );
        sessionId = context.sessionId;
        status = 200;
        return sendJson(res, status, context, cors, correlationId);
      }

      // ── TEMPORARY DEMO INFRASTRUCTURE (Slice 3) ─────────────────────
      // Server-held bridge for the controlled demonstration. Authorized by
      // DEMO_BRIDGE_SECRET via Authorization: Bearer only. No browser CORS.
      // The demo ROUTES are temporary; the GuideHerd Connect conversation
      // layer they delegate to is not.
      if (method === 'POST' && path === '/api/v1/demo/connect') {
        adoptSuppliedCorrelation(await authorizeAssistant(req, 'conversation:connect'));
        const adapter = adapterFor(DEMO_FIRM_ID);
        // The request body is OPTIONAL and read leniently (size-capped;
        // unparseable bodies become undefined rather than 400): provider
        // dialects — a webhook UI that requires at least one JSON property,
        // or one that carries correlation metadata — are entirely the
        // adapter's concern. The adapter translates the dialect into a
        // neutral ConnectIntent; the Correlation Engine does the matching.
        const rawBody = await readJsonBodyLenient(req);
        const intent = adapter.translateConnect(rawBody);
        const context = await conversations.connect(DEMO_FIRM_ID, adapter.providerKey, intent, { correlationId });
        sessionId = context.sessionId;
        status = 200;
        return sendJson(res, status, context, null, correlationId);
      }

      // TEMPORARY DEMO INFRASTRUCTURE: operator view of the latest completed
      // Consultation Summary, for demos where Microsoft Graph is not yet
      // configured. Bridge-secret authorized; the Graph mailer is untouched.
      if (method === 'GET' && path === '/api/v1/demo/summary/latest') {
        adoptSuppliedCorrelation(await authorizeAssistant(req, 'summary:read'));
        const session = await store.latestCompleted(DEMO_FIRM_ID);
        if (!session) throw new NoCompletedSummaryError();
        sessionId = session.sessionId;
        status = 200;
        const html = renderSummaryHtml(buildConsultationSummary(session));
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'X-GuideHerd-Correlation-Id': correlationId,
        });
        return res.end(html);
      }

      // ── Live slot selection (ADR-0012 / #66) ────────────────────────
      // The scheduling assistant's runtime fetches availability from its
      // calendar provider, translates it into the neutral slot contract,
      // and asks GuideHerd what to OFFER: business hours constrain
      // (hard), policy ranks (deterministic), providers stay unaware of
      // policy. Service-identity authorized; the organization comes from
      // the authenticated identity, never the body.
      if (method === 'POST' && path === '/api/v1/scheduling/slot-selection') {
        const assistantIdentity = await authorizeAssistant(req, 'scheduling:select');
        if (!configService) {
          status = 503;
          return sendJson(res, status, {
            error: { code: 'config_unavailable', message: 'The configuration store is not available.', correlationId },
          }, null, correlationId);
        }
        const body = await readJsonBody(req);
        const selectionOrg = assistantIdentity.organizationKey || DEMO_FIRM_ID;
        const result = selectOfferedSlots({
          configService,
          organizationKey: selectionOrg,
          slots: body.slots,
          request: body.request || {},
          telemetry,
          correlationId,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        });
        status = 200;
        return sendJson(res, status, result, null, correlationId);
      }

      // ── Consolidated offered-slots ──────────────────────────────────
      // ONE small request replaces the model-mediated two-tool slot
      // transport (calendar tool result -> LLM re-emits the batch ->
      // slot selection) whose token-generation latency and silent policy
      // bypass failed the Issue #66 voice test. The route only
      // authorizes, parses, invokes the scheduling service, and maps the
      // typed result to HTTP — orchestration lives in
      // scheduling/offered-slots.js.
      //
      // Response contract (see docs/api/offered-slots.md):
      //   200 { status: "offered",         slots: [ranked, at most 2] }
      //   200 { status: "no-availability", slots: [] }
      //   4xx/5xx error envelope — the assistant must NOT offer times.
      //   There is NO raw-slot fallback state: every provider or
      //   processing failure fails closed to escalation.
      if (method === 'POST' && path === '/api/v1/scheduling/offered-slots') {
        const { organizationKey: tenantKey } = await authorizeTenantAssistant(req, 'scheduling:select');
        // A reusable scheduling endpoint requires a TENANT-SCOPED
        // identity. No demo fallback: an identity without an
        // organization can neither resolve nor probe any tenant's
        // calendar configuration.
        if (!tenantKey) {
          status = 403;
          return sendJson(res, status, {
            error: { code: 'organization_unresolved', message: 'The authenticated identity is not scoped to an organization.', correlationId },
          }, null, correlationId);
        }
        if (!configService) {
          status = 503;
          return sendJson(res, status, {
            error: { code: 'config_unavailable', message: 'The configuration store is not available.', correlationId },
          }, null, correlationId);
        }
        const body = await readJsonBody(req);
        const offeredRequest = validateOfferedSlotsRequest(body);
        sessionId = offeredRequest.sessionId ?? null;
        const requestStarted = Date.now();
        let result;
        try {
          // Per-tenant provider selection (GitLab #80): a tenant whose
          // calendar-targets domain names a native provider is served by
          // the native engine; every other tenant takes the deployed
          // legacy path unchanged. Selection is governed configuration —
          // never a header, never a request field.
          const nativeKey = nativeProviderKeyFor(configService, tenantKey);
          result = nativeKey
            ? await offerNativeSlots({
              configService,
              calendarProviders,
              bookingContexts,
              clock,
              organizationKey: tenantKey,
              request: offeredRequest,
              telemetry,
              correlationId,
            })
            : await offerSlots({
              configService,
              availabilityProvider,
              bookingContexts,
              clock,
              organizationKey: tenantKey,
              request: offeredRequest,
              telemetry,
              correlationId,
            });
        } catch (err) {
          if (err instanceof CalendarProviderError) {
            telemetry.event('scheduling.availability_failed', {
              severity: 'warn', component: 'calendar-provider', operation: 'offered-slots',
              organizationKey: tenantKey, correlationId, sessionId,
              code: err.code, detail: err.detail, totalMs: Date.now() - requestStarted,
            });
            // Native read failures fail closed exactly like legacy
            // provider failures: configuration-family -> 503, provider
            // trouble -> 502. Never a raw-slot fallback.
            status = err.code === 'calendar_provider_not_configured' ? 503 : 502;
            return sendJson(res, status, {
              error: { code: err.code, message: err.message, correlationId },
            }, null, correlationId);
          }
          if (err instanceof AvailabilityError) {
            telemetry.event('scheduling.availability_failed', {
              severity: 'warn', component: 'calendar-provider', operation: 'offered-slots',
              organizationKey: tenantKey, correlationId, sessionId,
              code: err.code, httpStatus: err.httpStatus, totalMs: Date.now() - requestStarted,
            });
            // Configuration-family failures (missing event type, coverage
            // gap, ambiguous routing) are 503; the provider's own
            // failures are 502; only a real timeout is 504.
            status = err.code === 'availability_timeout' ? 504
              : (['availability_not_configured', 'routing_unresolved'].includes(err.code) ? 503 : 502);
            return sendJson(res, status, {
              error: { code: err.code, message: err.message, correlationId },
            }, null, correlationId);
          }
          // Validation, configuration, and UNKNOWN errors propagate to
          // the global handler — fail closed; no catch-all ever turns a
          // processing failure into spoken appointment times.
          throw err;
        }

        // Bypass-detection bookkeeping (diagnostic; see the outcome
        // route): this session received a policy-governed offer. Lazy 1h
        // prune keeps the map bounded.
        if (offeredRequest.sessionId) {
          const cutoff = clock.now() - 60 * 60 * 1000;
          for (const [key, at] of offeredSlotsSessions) {
            if (at < cutoff) offeredSlotsSessions.delete(key);
          }
          offeredSlotsSessions.set(offeredRequest.sessionId, clock.now());
        }

        telemetry.event('scheduling.slots_offered', {
          severity: 'info', component: 'scheduling', operation: 'offered-slots',
          organizationKey: tenantKey, correlationId, sessionId,
          status: result.kind, routeKind: result.routeKind,
          // The booking-context ID only — the raw opaque value exists
          // solely in the response body, never in telemetry or logs.
          bookingContextId: result.bookingContextId,
          ...result.counts, ...result.timings,
        });
        status = 200;
        return sendJson(res, status, {
          status: result.kind, slots: result.slots, window: result.window,
          ...(result.bookingContext ? { bookingContext: result.bookingContext } : {}),
        }, null, correlationId);
      }

      // ── Governed booking ────────────────────────────────────────────
      // Books INSIDE a booking context issued by offered-slots: the event
      // type, duration, and permissible timestamps come from the durable
      // context row (PostgreSQL under the postgres operational provider)
      // — the model transports only the opaque context value, a chosen
      // timestamp, and attendee contact details.
      //
      // TOOL-FACING STATUS ENVELOPE: booking OUTCOMES ride HTTP 200 with
      // a deterministic `status` the agent always receives and can act on
      // (booked | rejected | expired | verification_required) — official
      // ElevenLabs documentation does not guarantee that non-2xx response
      // bodies reach the model, and mis-hearing a booking outcome is a
      // caller-facing failure. Request/auth errors (400/401/403/503)
      // remain HTTP errors: the prompt's "any error → escalate" branch
      // covers them. "booked" is present ONLY when Cal.com confirmed AND
      // the outcome row committed.
      if (method === 'POST' && path === '/api/v1/scheduling/book') {
        const { organizationKey: tenantKey } = await authorizeTenantAssistant(req, 'scheduling:book');
        if (!tenantKey) {
          status = 403;
          return sendJson(res, status, {
            error: { code: 'organization_unresolved', message: 'The authenticated identity is not scoped to an organization.', correlationId },
          }, null, correlationId);
        }
        if (!configService) {
          status = 503;
          return sendJson(res, status, {
            error: { code: 'config_unavailable', message: 'The configuration store is not available.', correlationId },
          }, null, correlationId);
        }
        const bookingRequest = validateBookingRequest(await readJsonBody(req));
        sessionId = bookingRequest.sessionId ?? null;
        const result = await bookAppointment({
          bookingContexts,
          bookingProvider,
          calendarProviders,
          configService,
          organizationKey: tenantKey,
          request: bookingRequest,
          clock,
        });
        sessionId = result.sessionId ?? sessionId;
        const bookingTelemetry = {
          organizationKey: tenantKey, correlationId, sessionId,
          bookingContextId: result.bookingContextId, routeKind: result.routeKind,
          code: result.reason, httpStatus: result.httpStatus,
          ...result.timings,
        };
        if (result.outcome === 'booked') {
          telemetry.event('scheduling.booking_created', {
            severity: 'info', component: 'scheduling', operation: 'book',
            ...bookingTelemetry, status: 'booked',
          });
          // A governed booking is bypass-detector evidence, same as a
          // governed offer (diagnostic bookkeeping only).
          if (sessionId) offeredSlotsSessions.set(sessionId, clock.now());
        } else if (result.outcome === 'verification_required') {
          telemetry.event('scheduling.booking_verification_required', {
            severity: 'error', component: 'scheduling', operation: 'book',
            ...bookingTelemetry, status: 'verification_required',
          });
        } else {
          telemetry.event('scheduling.booking_rejected', {
            severity: 'warn', component: 'scheduling', operation: 'book',
            ...bookingTelemetry, status: result.outcome,
          });
        }
        status = 200;
        return sendJson(res, status, {
          status: result.outcome,
          ...(result.outcome === 'booked'
            ? {
              startsAt: result.startsAt,
              durationMinutes: result.durationMinutes,
              ...(result.attorneyId ? { attorneyId: result.attorneyId } : {}),
            }
            : { reason: result.reason }),
        }, null, correlationId);
      }

      if (method === 'POST' && path === '/api/v1/demo/outcome') {
        adoptSuppliedCorrelation(await authorizeAssistant(req, 'conversation:complete'));
        const adapter = adapterFor(DEMO_FIRM_ID);
        const body = await readJsonBody(req);
        // The adapter translates the provider's dialect into the canonical
        // outcome contract; validation is shared and provider-independent.
        const { sessionId: outcomeSessionId, outcome } = adapter.translateOutcome(body);
        const result = await conversations.complete(outcomeSessionId, outcome, adapter.providerKey, { correlationId });
        sessionId = result.sessionId;
        // Policy-bypass detector (diagnostic): a BOOKED outcome for a
        // prepared session that never received a policy-governed offer
        // means appointment times were spoken from some other source.
        // That must be loud — the failed Issue #66 voice test proved a
        // silent bypass is otherwise invisible. In-memory bookkeeping:
        // a warning after a restart can be a false positive.
        if (outcome && outcome.status === 'booked' && !offeredSlotsSessions.has(outcomeSessionId)) {
          telemetry.event('scheduling.policy_bypass_suspected', {
            severity: 'warn', component: 'scheduling', operation: 'outcome',
            organizationKey: DEMO_FIRM_ID, correlationId, sessionId: outcomeSessionId,
          });
        }
        status = 200;
        return sendJson(res, status, result, null, correlationId);
      }

      // Console operations: GET (status) / DELETE (cancel) on a session,
      // authorized by the console bearer token. Tokens are read only from the
      // Authorization header — never from the URL.
      const sessionMatch = path.match(/^\/api\/v1\/handoffs\/([^/]+)$/);
      if (sessionMatch && sessionMatch[1] !== 'redeem' && (method === 'GET' || method === 'DELETE')) {
        const consoleToken = readBearerToken(req); // throws 401 if missing/malformed
        sessionId = sessionMatch[1];

        // Capability authorization (ADR-0010): a console token permits
        // status reads and cancellation on exactly its own session. The
        // repository verifies the credential itself (constant-time hash,
        // 403 on mismatch); this pins WHICH operations the capability may
        // perform. No success audit: status is high-frequency polling.
        const consoleCapability = { capability: { type: 'console-token', sessionId } };
        const sessionResource = { resource: { type: 'handoff-session', id: sessionId } };

        if (method === 'GET') {
          authz.authorize(consoleCapability, 'handoff:read', sessionResource);
          const statusBody = await service.status(sessionId, consoleToken);
          status = 200;
          return sendJson(res, status, statusBody, cors, correlationId);
        }
        authz.authorize(consoleCapability, 'handoff:cancel', sessionResource);
        const cancelBody = await service.cancel(sessionId, consoleToken);
        status = 200;
        return sendJson(res, status, cancelBody, cors, correlationId);
      }

      status = 404;
      return sendJson(res, status, { error: { code: 'not_found', message: 'Resource not found.' } }, cors, correlationId);
    } catch (err) {
      const path = typeof req.url === 'string' ? req.url.split('?')[0] : String(req.url);
      if (err instanceof HandoffError || err instanceof ConfigError || err instanceof ConnectError || err instanceof IdentityError) {
        status = err.status;
        const { category } = categorize(err);
        const body = err.toBody();
        // The correlation ID rides in every controlled error envelope so a
        // support conversation can be tied to the exact failing request.
        body.error.correlationId = correlationId;
        // Connect-facing (assistant) responses additionally carry a calm,
        // provider-free caller message the Guide can deliver or act on.
        if (isDemoPath) body.error.callerMessage = callerMessageFor(category);
        telemetry.event(status === 400 ? 'validation.failed' : 'request.failed', {
          severity: status >= 500 ? 'error' : (status === 429 ? 'warn' : 'info'),
          component: 'http-api',
          operation: `${req.method} ${path}`,
          category,
          code: err.code,
          httpStatus: status,
          correlationId,
          sessionId,
        });
        return sendJson(res, status, body, cors, correlationId);
      }
      // Unexpected internal error: sanitized diagnostics internally (error
      // name + stack frames, message stripped), a calm generic envelope
      // externally. Never raw exception text, secrets, or PII.
      status = 500;
      telemetry.event('internal.unexpected_error', {
        severity: 'error',
        component: 'internal',
        operation: `${req.method} ${path}`,
        category: 'unexpected_error',
        httpStatus: status,
        correlationId,
        sessionId,
        ...sanitizeError(err),
      });
      const body = {
        error: { code: 'internal_error', message: 'An unexpected error occurred.', correlationId },
      };
      if (isDemoPath) body.error.callerMessage = callerMessageFor('unexpected_error');
      return sendJson(res, status, body, cors, correlationId);
    } finally {
      logRequest(req, status, sessionId, Date.now() - startedAt, correlationId);
    }
  };
}

/**
 * Extract a bearer token from the Authorization header.
 * Throws 401 when the header is missing or malformed. The raw token is never
 * logged and never appears in error messages.
 */
function readBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') throw new UnauthorizedError();
  const match = header.match(/^Bearer\s+(\S+)$/);
  if (!match) throw new UnauthorizedError();
  return match[1];
}

/**
 * Read a request body leniently, enforcing the size cap: valid JSON parses,
 * while an empty or unparseable body resolves to undefined instead of
 * rejecting. Used where the body is optional provider ceremony whose
 * interpretation belongs entirely to the Conversation Adapter.
 */
function readJsonBodyLenient(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new MalformedRequestError('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined); // tolerated: dialect hygiene is the adapter's concern
      }
    });
    req.on('error', () => resolve(undefined)); // discarded anyway
  });
}

/** Read and JSON-parse a request body, enforcing the size cap. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new MalformedRequestError('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new MalformedRequestError());
      }
    });
    req.on('error', () => reject(new MalformedRequestError()));
  });
}

function sendJson(res, status, body, cors, correlationId) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // Security review (#39): API responses are never sniffable, never
    // framed, never leak referrers; HSTS pins the public TLS edge
    // (browsers ignore it over plain-http local development).
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    ...(correlationId ? { 'X-GuideHerd-Correlation-Id': correlationId } : {}),
    ...(cors || {}),
  });
  res.end(JSON.stringify(body));
}

/** Structured request log. Tokens are NEVER logged; only the sessionId is. */
function logRequest(req, status, sessionId, durationMs, correlationId) {
  const path = typeof req.url === 'string' ? req.url.split('?')[0] : req.url;
  console.log(JSON.stringify({
    level: 'info',
    method: req.method,
    path,
    status,
    sessionId: sessionId ?? null,
    correlationId: correlationId ?? null,
    durationMs,
  }));
}

module.exports = { createApp, MAX_BODY_BYTES };
