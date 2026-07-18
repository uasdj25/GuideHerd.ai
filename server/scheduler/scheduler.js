'use strict';

/**
 * The GuideHerd Scheduler Contract (ADR-0018).
 *
 * NOT a reminder emailer and NOT cron: the permanent home for TIME-BASED
 * GuideHerd business behavior. The scheduler owns exactly one question —
 * "what business action becomes eligible now?" — and executes registered
 * GuideHerd ACTIONS at the correct time. It knows nothing about email,
 * SMS, Graph, Twilio, Teams, or any provider: an action handler states
 * business intent (usually through the Notification Contract), and
 * delivery remains a Notification/Communication responsibility.
 * Appointment reminders are the first scheduled workflow; follow-ups,
 * surveys, document requests, retention campaigns, and integrations
 * register the same way.
 *
 * ── The scheduled action ───────────────────────────────────────────────────
 *   {
 *     actionKey,        unique identifier AND dedupe key — scheduling the
 *                       same key twice is a no-op by construction, so
 *                       duplicate producers/redeliveries are structurally
 *                       harmless (`<actionType>:<entity>[:<qualifier>]`)
 *     actionType,       which registered handler executes it
 *     organizationKey,  tenant scope
 *     sessionId?,       related conversation, when there is one
 *     correlationId?,   observability thread (Issue #8)
 *     runAtMs,          UTC execution time — scheduling is ALWAYS UTC
 *                       internally; organization timezones are a
 *                       presentation concern (templates, consoles)
 *     expiresAtMs?,     after this UTC instant the action is worthless
 *                       (a reminder after the appointment): it EXPIRES
 *                       instead of executing late
 *     payload,          small, safe GuideHerd facts only — identifiers,
 *                       statuses, timestamps; never tokens, PII, or
 *                       provider payloads
 *   }
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   pending ──(runAt reached)── ready ──claim── processing ── completed
 *      │                                            │
 *      │                                            └── failed ──retry──╮
 *      ├── cancelled (producer withdrew it)             ▲               │
 *      └── expired (expiresAt passed unexecuted)        ╰───────────────╯
 *                                                (bounded; exhaustion is
 *                                                 terminal 'failed')
 *
 * 'ready' is the PRESENTED state of a due, unclaimed pending action —
 * the claim transitions pending→processing directly (one atomic write;
 * a separate ready hop would add a write and no safety).
 *
 * ── Guarantees (precise) ───────────────────────────────────────────────────
 * The reliability model is the Durable Event Outbox's, reused not
 * reinvented: atomic conditional claims (at most one concurrent executor
 * per action, across restarts and PostgreSQL instances), bounded retries
 * with deterministic clock-based backoff, stale-claim recovery, and
 * drain()-based processing behind the SAME poller/boot-recovery liveness
 * (ADR-0017 §3) — no new timers, no cron, no second processing
 * architecture.
 *   - Execution is AT-LEAST-ONCE per scheduled action.
 *   - EXACTLY-ONCE business effects are the handler's contract: handlers
 *     must be idempotent (the reminder handler is, via its notification
 *     delivery claim).
 *   - Every due action is EVENTUALLY executed (or expired) while at
 *     least one healthy API instance runs — no traffic, no restart
 *     required.
 *   - An action never executes before runAtMs, and never executes after
 *     expiresAtMs (it expires instead).
 */

const { systemClock } = require('../handoff/clock');

const SCHEDULER_STALE_PROCESSING_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = [1_000, 10_000, 60_000, 300_000];

const TERMINAL_STATES = Object.freeze(['completed', 'cancelled', 'expired']);

/** Validate a scheduled action (producer programming contract). */
function validateScheduledAction(action) {
  if (!action || typeof action.actionKey !== 'string' || action.actionKey.trim() === '') {
    throw new TypeError('A scheduled action must declare a nonblank actionKey.');
  }
  if (typeof action.actionType !== 'string' || action.actionType.trim() === '') {
    throw new TypeError('A scheduled action must declare an actionType.');
  }
  if (typeof action.organizationKey !== 'string' || action.organizationKey.trim() === '') {
    throw new TypeError('A scheduled action must declare an organizationKey.');
  }
  if (!Number.isFinite(action.runAtMs)) {
    throw new TypeError('A scheduled action must declare a finite runAtMs (UTC milliseconds).');
  }
  if (action.expiresAtMs !== undefined && action.expiresAtMs !== null && !Number.isFinite(action.expiresAtMs)) {
    throw new TypeError('expiresAtMs must be a finite UTC millisecond timestamp when present.');
  }
  return {
    actionKey: action.actionKey.trim(),
    actionType: action.actionType.trim(),
    organizationKey: action.organizationKey.trim(),
    sessionId: action.sessionId ?? null,
    correlationId: action.correlationId ?? null,
    runAtMs: action.runAtMs,
    expiresAtMs: action.expiresAtMs ?? null,
    payload: action.payload ?? {},
  };
}

/** The presented state: a due, unclaimed pending action reads as 'ready'. */
function presentState(record, nowMs) {
  if (record.state === 'pending' && record.runAtMs <= nowMs) return 'ready';
  return record.state;
}

/** In-memory reference implementation of the scheduled-action store. */
function createInMemoryScheduledActionStore({ clock = systemClock() } = {}) {
  /** @type {Map<string, object>} actionKey -> record */
  const actions = new Map();

  function claimableNow(record, now, maxAttempts) {
    if (record.state === 'pending') {
      return record.runAtMs <= now;
    }
    if (record.state === 'failed') {
      return record.attempts < maxAttempts
        && typeof record.nextAttemptAtMs === 'number' && record.nextAttemptAtMs <= now;
    }
    if (record.state === 'processing') {
      return now - record.updatedAtMs >= SCHEDULER_STALE_PROCESSING_MS;
    }
    return false;
  }

  return {
    /**
     * Schedule an action if its key does not exist yet. Structural
     * dedupe: re-scheduling an existing key changes nothing and reports
     * scheduled=false.
     */
    async schedule(action) {
      const validated = validateScheduledAction(action);
      const existing = actions.get(validated.actionKey);
      if (existing) return { scheduled: false, action: { ...existing } };
      const now = clock.now();
      const record = {
        ...validated,
        state: 'pending',
        attempts: 0,
        nextAttemptAtMs: null,
        createdAtMs: now,
        updatedAtMs: now,
      };
      actions.set(record.actionKey, record);
      return { scheduled: true, action: { ...record } };
    },

    /** Cancel a pending (or retryable failed) action. Terminal states stay. */
    async cancel(actionKey) {
      const record = actions.get(actionKey);
      if (!record || TERMINAL_STATES.includes(record.state)) {
        return { cancelled: false, state: record ? record.state : null };
      }
      record.state = 'cancelled';
      record.updatedAtMs = clock.now();
      return { cancelled: true, state: 'cancelled' };
    },

    /** Expire every unexecuted action whose expiresAt has passed. */
    async expireDue(now) {
      const expired = [];
      for (const record of actions.values()) {
        if (TERMINAL_STATES.includes(record.state)) continue;
        if (typeof record.expiresAtMs === 'number' && record.expiresAtMs <= now) {
          record.state = 'expired';
          record.updatedAtMs = now;
          expired.push({ ...record });
        }
      }
      return expired;
    },

    /** Actions currently claimable, oldest runAt first. */
    async claimable({ maxAttempts, limit = 50 } = {}) {
      const now = clock.now();
      return [...actions.values()]
        .filter((record) => claimableNow(record, now, maxAttempts))
        .sort((a, b) => a.runAtMs - b.runAtMs || a.actionKey.localeCompare(b.actionKey))
        .slice(0, limit)
        .map((record) => ({ ...record }));
    },

    /** Atomic claim: at most one concurrent executor per action. */
    async claim(actionKey, { maxAttempts } = {}) {
      const record = actions.get(actionKey);
      if (!record) return null;
      const now = clock.now();
      if (!claimableNow(record, now, maxAttempts)) return null;
      record.state = 'processing';
      record.attempts += 1;
      record.nextAttemptAtMs = null;
      record.updatedAtMs = now;
      return { ...record };
    },

    async complete(actionKey) {
      const record = actions.get(actionKey);
      if (record) {
        record.state = 'completed';
        record.updatedAtMs = clock.now();
      }
    },

    async fail(actionKey, { nextAttemptAtMs }) {
      const record = actions.get(actionKey);
      if (record) {
        record.state = 'failed';
        record.nextAttemptAtMs = nextAttemptAtMs ?? null;
        record.updatedAtMs = clock.now();
      }
    },

    /** Recent actions, newest scheduled first (operational visibility). */
    async listRecent({ organizationKey, limit = 100 } = {}) {
      const now = clock.now();
      return [...actions.values()]
        .filter((record) => !organizationKey || record.organizationKey === organizationKey)
        .sort((a, b) => b.createdAtMs - a.createdAtMs || a.actionKey.localeCompare(b.actionKey))
        .slice(0, limit)
        .map((record) => ({ ...record, presentedState: presentState(record, now) }));
    },

    async get(actionKey) {
      const record = actions.get(actionKey);
      return record ? { ...record, presentedState: presentState(record, clock.now()) } : undefined;
    },

    async size() {
      return actions.size;
    },
  };
}

/**
 * The scheduler processor: registered action handlers, bounded retries,
 * expiry, isolation. Deliberately shaped like the outbox processor —
 * same claim discipline, same drain() contract, so it sits behind the
 * SAME liveness poller with zero new infrastructure.
 *
 * @param {{
 *   store: ReturnType<typeof createInMemoryScheduledActionStore>,
 *   clock?: import('../handoff/clock').Clock,
 *   telemetry?: { event: Function },
 *   maxAttempts?: number,
 *   backoffMs?: number[],
 * }} deps
 */
function createScheduler({ store, clock = systemClock(), telemetry, maxAttempts = DEFAULT_MAX_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS } = {}) {
  const actionStore = store || createInMemoryScheduledActionStore({ clock });
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  /** @type {Map<string, { actionType: string, handle: Function }>} */
  const handlers = new Map();

  function safeFields(action) {
    return {
      component: 'internal',
      operation: `scheduler:${action.actionType}`,
      actionType: action.actionType,
      actionKey: action.actionKey,
      organizationKey: action.organizationKey,
      sessionId: action.sessionId ?? undefined,
      correlationId: action.correlationId ?? undefined,
      runAt: new Date(action.runAtMs).toISOString(),
    };
  }

  const api = {
    store: actionStore,

    /**
     * Register the handler for one action type. A future scheduled
     * workflow is ONE action definition plus ONE registration — the
     * scheduler core does not change.
     */
    register({ actionType, handle } = {}) {
      if (typeof actionType !== 'string' || actionType === '' || typeof handle !== 'function') {
        throw new TypeError('A scheduler handler must declare an actionType and handle().');
      }
      if (handlers.has(actionType)) {
        throw new TypeError(`Scheduler handler already registered: ${actionType}`);
      }
      handlers.set(actionType, { actionType, handle });
    },

    handlerTypes() {
      return [...handlers.keys()];
    },

    /**
     * Schedule a business action (producer API). Structural dedupe by
     * actionKey; scheduling telemetry only on first insert.
     */
    async schedule(action) {
      const result = await actionStore.schedule(action);
      if (result.scheduled) {
        emit('scheduler.action_scheduled', { severity: 'info', ...safeFields(result.action) });
      }
      return result;
    },

    /** Cancel a scheduled action by key (producer API). */
    async cancel(actionKey) {
      return actionStore.cancel(actionKey);
    },

    /**
     * Execute everything eligible now: expire the worthless, claim the
     * due, run handlers, retry failures with bounded backoff. Serialized:
     * overlapping drains coalesce. Deterministic in tests (no timers).
     */
    async drain() {
      if (api._draining) return api._draining;
      api._draining = (async () => {
        try {
          for (const action of await actionStore.expireDue(clock.now())) {
            emit('scheduler.action_expired', { severity: 'warn', ...safeFields(action) });
          }
          const candidates = await actionStore.claimable({ maxAttempts, limit: 100 });
          for (const candidate of candidates) {
            const claimed = await actionStore.claim(candidate.actionKey, { maxAttempts });
            if (!claimed) continue; // another executor holds it, or it settled
            const handler = handlers.get(claimed.actionType);
            try {
              if (!handler) throw new TypeError(`No handler registered for action type: ${claimed.actionType}`);
              await handler.handle(claimed);
              await actionStore.complete(claimed.actionKey);
              emit('scheduler.action_completed', {
                severity: 'info', ...safeFields(claimed), attempt: claimed.attempts,
              });
            } catch (err) {
              const exhausted = claimed.attempts >= maxAttempts;
              const backoff = backoffMs[Math.min(claimed.attempts - 1, backoffMs.length - 1)] ?? 0;
              await actionStore.fail(claimed.actionKey, {
                nextAttemptAtMs: exhausted ? null : clock.now() + backoff,
              });
              emit('scheduler.action_failed', {
                severity: exhausted ? 'error' : 'warn',
                ...safeFields(claimed),
                attempt: claimed.attempts, maxAttempts,
                errorName: err && err.name ? String(err.name) : 'Error',
              });
            }
          }
        } finally {
          api._draining = null;
        }
      })();
      return api._draining;
    },
  };
  return api;
}

module.exports = {
  createScheduler,
  createInMemoryScheduledActionStore,
  validateScheduledAction,
  presentState,
  SCHEDULER_STALE_PROCESSING_MS,
  DEFAULT_MAX_ATTEMPTS,
  TERMINAL_STATES,
};
