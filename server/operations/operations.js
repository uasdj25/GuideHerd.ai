'use strict';

/**
 * The GuideHerd Operations Center (ADR-0014) — the permanent operational
 * observability framework. The dashboard is merely its first consumer.
 *
 * GuideHerd owns operational visibility: an operator understands what the
 * platform is doing from GuideHerd operational data — handoff lifecycle
 * (Operational Store), conversation lifecycle (Connect events),
 * notification delivery (delivery store), and structured operational
 * events (Issue #8 telemetry) — never from provider logs. Providers never
 * supply dashboard data; every view below reads GuideHerd stores and
 * GuideHerd events only, and provider request IDs appear solely as
 * secondary references.
 *
 * ── The Operations Contract ────────────────────────────────────────────────
 * A queryable, organization-scoped surface over existing data (nothing is
 * duplicated; the Operational Store remains the source of truth for
 * state, the event feed for activity):
 *
 *   overview(org)        counts + health, the dashboard's front page
 *   sessions(org, opts)  handoff lifecycle views (PII-stripped)
 *   notifications(org)   delivery records joined to the org via session
 *   events(org, opts)    the recent operational event feed
 *   timeline(org, correlationId)  one request's complete story
 *   search(org, query)   correlation ID / session ID / attorney
 *   health()             GuideHerd capability availability
 *
 * Future operational modules (notification queue, reminder scheduler,
 * durable outbox, background jobs, diagnostics, audit history,
 * integration health) plug in as additional query methods + dashboard
 * modules over their own stores — the contract grows additively.
 *
 * ── Events feed ────────────────────────────────────────────────────────────
 * A bounded in-memory ring of recent events observed from the telemetry
 * emitter and the Connect conversation events. Deliberately ephemeral in
 * v1: durable operational-event persistence is the outbox work ADR-0006
 * deferred, and this feed migrates onto it without changing the contract.
 * Every entry passes the telemetry field allowlist — the feed can never
 * hold more than telemetry may say (no PII, no tokens, no payloads).
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * Session views expose OPERATIONAL METADATA ONLY: identifiers, statuses,
 * timestamps, scheduling references. Caller name, email, and phone are
 * stripped here, structurally, before anything reaches a route.
 */

const { ALLOWED_FIELDS } = require('../telemetry/telemetry');
const { systemClock } = require('../handoff/clock');

const DEFAULT_EVENT_BUFFER = 500;

/** Session status groupings for the dashboard views. */
const STATUS_GROUPS = Object.freeze({
  pending: Object.freeze(['awaiting-transfer']),
  active: Object.freeze(['connected', 'scheduling']),
  completed: Object.freeze(['booked']),
  failed: Object.freeze(['failed', 'escalated', 'cancelled', 'expired']),
});

/** Strip a session to operational metadata — never caller PII. */
function presentOperationalSession(session) {
  const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
  return {
    sessionId: session.sessionId,
    status: session.status,
    attorneyId: session.scheduling ? session.scheduling.attorneyId ?? null : null,
    practiceAreaId: session.scheduling ? session.scheduling.practiceAreaId ?? null : null,
    consultationTypeId: session.scheduling ? session.scheduling.consultationTypeId ?? null : null,
    source: session.handoff ? session.handoff.source ?? null : null,
    summaryDelivery: session.summaryDelivery ?? null,
    createdAt: iso(session.createdAtMs),
    expiresAt: iso(session.expiresAtMs),
    connectedAt: iso(session.redeemedAtMs),
    completedAt: iso(session.completedAtMs),
    cancelledAt: iso(session.cancelledAtMs),
  };
}

/** Handoff lifecycle timeline entries derived from one session's record. */
function sessionLifecycleEntries(session) {
  const presented = presentOperationalSession(session);
  const entries = [];
  const push = (at, label) => { if (at) entries.push({ at, kind: 'handoff', label, sessionId: presented.sessionId }); };
  push(presented.createdAt, 'handoff prepared');
  push(presented.connectedAt, 'caller connected');
  push(presented.completedAt, `outcome recorded: ${presented.status}`);
  push(presented.cancelledAt, 'handoff cancelled');
  return entries;
}

/**
 * @param {{
 *   store: object,                      handoff repository
 *   notificationDeliveryStore: object,
 *   configService?: object|null,
 *   capabilities?: Array<{ capability: string, check: () => Promise<string>|string }>,
 *   clock?: import('../handoff/clock').Clock,
 *   eventBufferSize?: number,
 * }} deps
 */
function createOperationsCenter({
  store,
  notificationDeliveryStore,
  outboxStore = null,
  configService = null,
  capabilities = [],
  clock = systemClock(),
  eventBufferSize = DEFAULT_EVENT_BUFFER,
}) {
  /** @type {Array<object>} newest last; bounded. */
  const eventFeed = [];

  function sanitizeFields(fields) {
    const safe = {};
    for (const key of ALLOWED_FIELDS) {
      if (key === 'severity' || key === 'stack') continue; // level captured; stacks stay in logs
      if (fields && fields[key] !== undefined && fields[key] !== null) safe[key] = fields[key];
    }
    return safe;
  }

  /** True when an event belongs to the organization's view. */
  async function eventVisibleTo(entry, organizationKey) {
    if (entry.fields.organizationKey) return entry.fields.organizationKey === organizationKey;
    if (entry.fields.sessionId) {
      const session = await store.get(entry.fields.sessionId).catch(() => undefined);
      return Boolean(session && session.firmId === organizationKey);
    }
    return false; // events with no organization linkage stay platform-internal
  }

  /** Map a durable outbox event into the feed entry shape. */
  function outboxEntry(event) {
    const fields = {
      organizationKey: event.organizationKey,
      code: event.payload && event.payload.status ? event.payload.status : undefined,
    };
    if (event.sessionId) fields.sessionId = event.sessionId;
    if (event.correlationId) fields.correlationId = event.correlationId;
    return {
      at: new Date(event.at).toISOString(),
      name: event.type,
      severity: 'info',
      fields,
      durable: true,
    };
  }

  async function orgEvents(organizationKey, { correlationId, limit = 100 } = {}) {
    const matches = [];
    for (let i = eventFeed.length - 1; i >= 0 && matches.length < Math.max(1, limit); i--) {
      const entry = eventFeed[i];
      if (correlationId && entry.fields.correlationId !== correlationId) continue;
      if (await eventVisibleTo(entry, organizationKey)) matches.push(entry);
    }
    // The Durable Event Outbox (ADR-0017) is the durable backbone of the
    // feed: domain events survive restarts and multi-instance deployments;
    // the in-memory ring supplements with ephemeral telemetry diagnostics.
    if (outboxStore) {
      const durable = await outboxStore.listRecent({ organizationKey, limit: Math.max(1, limit) });
      for (const event of durable) {
        if (correlationId && event.correlationId !== correlationId) continue;
        matches.push(outboxEntry(event));
      }
      matches.sort((a, b) => b.at.localeCompare(a.at) || String(a.name).localeCompare(String(b.name)));
      return matches.slice(0, Math.max(1, limit));
    }
    return matches;
  }

  const api = {
    /**
     * Observe one operational event (wired to the telemetry emitter and
     * the Connect conversation events). Never throws.
     */
    observe(name, fields = {}) {
      try {
        eventFeed.push({
          at: new Date(clock.now()).toISOString(),
          name,
          severity: fields && typeof fields.severity === 'string' ? fields.severity : 'info',
          fields: sanitizeFields(fields),
        });
        if (eventFeed.length > eventBufferSize) eventFeed.splice(0, eventFeed.length - eventBufferSize);
      } catch { /* observability never breaks a workflow */ }
    },

    /** Dashboard front page: session counts, notification counts, health. */
    async overview(organizationKey) {
      const byStatus = await store.countByStatus(organizationKey);
      const groups = {};
      for (const [group, statuses] of Object.entries(STATUS_GROUPS)) {
        groups[group] = statuses.reduce((sum, status) => sum + (byStatus[status] || 0), 0);
      }
      const notifications = await api.notifications(organizationKey, { limit: 200 });
      const notificationCounts = {};
      for (const record of notifications) {
        notificationCounts[record.status] = (notificationCounts[record.status] || 0) + 1;
      }
      return {
        sessions: { byStatus, groups },
        notifications: notificationCounts,
        health: await api.health(),
      };
    },

    /** Handoff lifecycle views. `group` is a STATUS_GROUPS key or absent. */
    async sessions(organizationKey, { group, limit = 50 } = {}) {
      const statuses = group ? STATUS_GROUPS[group] : undefined;
      if (group && !statuses) return [];
      const sessions = await store.listRecent(organizationKey, { limit, statuses: statuses ? [...statuses] : undefined });
      return sessions.map(presentOperationalSession);
    },

    /** Notification delivery records for the organization's sessions. */
    async notifications(organizationKey, { limit = 50, failedOnly = false } = {}) {
      const records = await notificationDeliveryStore.listRecent({ limit: Math.max(limit * 4, 200) });
      const results = [];
      for (const record of records) {
        if (results.length >= Math.max(1, limit)) break;
        if (failedOnly && record.status !== 'failed') continue;
        // Keys are '<type>:<sessionId>[:<qualifier>]' (ADR-0011 — the
        // qualifier carries e.g. a reminder schedule slot); the org join
        // goes through the session — never trusted from the key alone.
        const [type, sessionId] = record.notificationKey.split(':');
        if (!sessionId) continue;
        const session = await store.get(sessionId).catch(() => undefined);
        if (!session || session.firmId !== organizationKey) continue;
        results.push({
          notificationKey: record.notificationKey,
          type,
          sessionId,
          status: record.status,
          claimedAt: record.claimedAtMs ? new Date(record.claimedAtMs).toISOString() : null,
        });
      }
      return results;
    },

    /** The recent operational event feed, newest first, org-scoped. */
    async events(organizationKey, options = {}) {
      return orgEvents(organizationKey, options);
    },

    /** Recent error-severity events, newest first, org-scoped. */
    async recentErrors(organizationKey, { limit = 50 } = {}) {
      const events = await orgEvents(organizationKey, { limit: eventBufferSize });
      return events.filter((e) => e.severity === 'error' || e.severity === 'warn').slice(0, Math.max(1, limit));
    },

    /**
     * One request's complete operational story: handoff lifecycle,
     * conversation lifecycle, notification and operational events, merged
     * chronologically. The correlation ID is the first-class key.
     */
    async timeline(organizationKey, correlationId) {
      const events = await orgEvents(organizationKey, { correlationId, limit: eventBufferSize });
      const entries = [];
      const sessionIds = new Set();
      for (const entry of events) {
        if (entry.fields.sessionId) sessionIds.add(entry.fields.sessionId);
        entries.push({
          at: entry.at,
          kind: entry.name.startsWith('conversation.') ? 'conversation'
            : entry.name.startsWith('notification.') ? 'notification' : 'event',
          label: entry.name,
          sessionId: entry.fields.sessionId ?? null,
          fields: entry.fields,
        });
      }
      for (const sessionId of sessionIds) {
        const session = await store.get(sessionId).catch(() => undefined);
        if (session && session.firmId === organizationKey) {
          entries.push(...sessionLifecycleEntries(session));
        }
      }
      entries.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
      return { correlationId, entries };
    },

    /**
     * Operator search: GuideHerd identifiers only. Correlation IDs and
     * session/handoff IDs resolve directly; anything else matches attorney
     * keys over recent sessions. Provider request IDs are deliberately not
     * searchable identifiers.
     */
    async search(organizationKey, query) {
      const q = String(query || '').trim();
      if (q === '') return { kind: 'empty', results: [] };
      if (/^gh-[0-9a-f]{6,}$/i.test(q) || /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(q) === false) {
        // fallthrough below for non-correlation shapes
      }
      if (q.startsWith('gh-')) {
        const { entries } = await api.timeline(organizationKey, q);
        return { kind: 'correlation', results: entries };
      }
      const direct = await store.get(q).catch(() => undefined);
      if (direct && direct.firmId === organizationKey) {
        return { kind: 'session', results: [presentOperationalSession(direct)] };
      }
      const recent = await store.listRecent(organizationKey, { limit: 200 });
      const byAttorney = recent
        .filter((s) => s.scheduling && s.scheduling.attorneyId === q)
        .map(presentOperationalSession);
      return { kind: byAttorney.length > 0 ? 'attorney' : 'none', results: byAttorney };
    },

    /** GuideHerd capability health — capabilities, not infrastructure. */
    async health() {
      const results = [];
      // Operational Store: can the platform read its own state?
      try {
        await store.size();
        results.push({ capability: 'operational-store', status: 'available' });
      } catch {
        results.push({ capability: 'operational-store', status: 'unavailable' });
      }
      // Configuration Store: is firm configuration readable?
      if (!configService) {
        results.push({ capability: 'configuration-store', status: 'not-configured' });
      } else {
        try {
          configService.organizations.list({});
          results.push({ capability: 'configuration-store', status: 'available' });
        } catch {
          results.push({ capability: 'configuration-store', status: 'unavailable' });
        }
      }
      for (const { capability, check } of capabilities) {
        try {
          results.push({ capability, status: await check() });
        } catch {
          results.push({ capability, status: 'unavailable' });
        }
      }
      return results;
    },

    /** Feed size (tests/introspection). */
    eventCount() {
      return eventFeed.length;
    },
  };

  return api;
}

module.exports = { createOperationsCenter, presentOperationalSession, STATUS_GROUPS };
