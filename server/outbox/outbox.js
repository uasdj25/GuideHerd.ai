'use strict';

/**
 * The GuideHerd Durable Event Outbox (ADR-0017).
 *
 * NOT a notification queue and NOT a scheduler: the permanent foundation
 * for asynchronous GuideHerd work. Business transactions persist durable
 * DOMAIN EVENTS in the same transaction as the business change; background
 * consumers process them afterward. Producers never know who consumes;
 * consumers never know who produced. Notifications are the first
 * consumer; reminder scheduling, Operations history, integrations,
 * analytics, audit, and synchronization build on the same foundation.
 *
 * ── The transactional boundary (exact) ─────────────────────────────────────
 * `append(event, runner?)` is called by a PUBLISHER inside its own
 * business transaction: in PostgreSQL the repository passes its
 * transaction client, so the outbox INSERT commits or rolls back with the
 * business row; in memory the append is part of the repository's single
 * synchronous pass. Therefore: a business operation cannot succeed
 * without its event, and no event can exist for a failed operation.
 *
 * ── Delivery model and guarantees ──────────────────────────────────────────
 * Per (event, consumer) delivery record with the lifecycle:
 *   pending -> processing -> completed
 *                       \\-> failed (bounded retries, deterministic
 *                            backoff) -> abandoned (exhausted)
 * Claims are atomic conditional writes (the platform's standard claim
 * pattern), so a delivery has at most one concurrent processor — across
 * restarts and, in PostgreSQL, across instances. A crash mid-processing
 * leaves a stale `processing` claim that becomes re-claimable after the
 * stale window: AT-LEAST-ONCE delivery. EXACTLY-ONCE business effects
 * are the consumer's contract: every consumer must be idempotent (the
 * notification consumer already is, via delivery-claim keys).
 * Consumers are isolated: one consumer's failure never blocks another's
 * delivery of the same event. Ordering: events are processed in
 * publication order per drain pass; consumers must not assume exactly-
 * once or global ordering across retries.
 *
 * ── Processing and liveness ────────────────────────────────────────────────
 * `drain()` processes everything pending and is triggered three ways:
 * (a) after a publishing workflow commits (a nudge — low latency),
 * (b) at boot (restart recovery), and (c) by the in-process POLLER
 * (`createOutboxPoller`), which periodically drains so pending retries
 * and stale processing claims recover WITHOUT new traffic or a restart.
 *
 * The liveness guarantee, precisely:
 *   - delivery is AT-LEAST-ONCE to every registered consumer;
 *   - every claimable delivery is EVENTUALLY processed while at least
 *     one healthy API instance is running (the poller drains on an
 *     interval; atomic claims keep concurrent instances safe);
 *   - EXACTLY-ONCE business effects remain the consumer's idempotency
 *     responsibility.
 * No cron, no brokers, no external infrastructure.
 */

const { systemClock } = require('../handoff/clock');

const OUTBOX_STALE_PROCESSING_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = [1_000, 10_000, 60_000, 300_000];

/** Validate a published event's shape (publisher programming contract). */
function validateEvent(event) {
  if (!event || typeof event.type !== 'string' || event.type.trim() === '') {
    throw new TypeError('An outbox event must declare a nonblank type.');
  }
  if (typeof event.organizationKey !== 'string' || event.organizationKey.trim() === '') {
    throw new TypeError('An outbox event must declare an organizationKey.');
  }
  return {
    type: event.type.trim(),
    organizationKey: event.organizationKey.trim(),
    sessionId: event.sessionId ?? null,
    correlationId: event.correlationId ?? null,
    payload: event.payload ?? {},
  };
}

/** In-memory reference implementation of the outbox store contract. */
function createInMemoryOutboxStore({ clock = systemClock() } = {}) {
  let nextId = 1;
  /** @type {Array<object>} publication order */
  const events = [];
  /** @type {Map<string, object>} `${eventId}:${consumer}` -> delivery */
  const deliveries = new Map();

  /** Synchronous append — used INSIDE a repository's atomic pass. */
  function appendSync(event) {
    const validated = validateEvent(event);
    const row = { id: nextId++, at: clock.now(), ...validated };
    events.push(row);
    return row;
  }

  return {
    appendSync,

    /** Append inside the publisher's synchronous business pass. */
    async append(event) {
      return appendSync(event);
    },

    /** Events with no completed/abandoned delivery for the consumer. */
    async claimable(consumer, { limit = 50 } = {}) {
      const now = clock.now();
      const out = [];
      for (const event of events) {
        if (out.length >= limit) break;
        const delivery = deliveries.get(`${event.id}:${consumer}`);
        if (!delivery) { out.push(event); continue; }
        if (delivery.status === 'failed' && delivery.nextAttemptAtMs <= now) out.push(event);
        else if (delivery.status === 'processing' && now - delivery.updatedAtMs >= OUTBOX_STALE_PROCESSING_MS) out.push(event);
      }
      return out;
    },

    /** Atomic claim: at most one concurrent processor per delivery. */
    async claim(eventId, consumer) {
      const now = clock.now();
      const key = `${eventId}:${consumer}`;
      const delivery = deliveries.get(key);
      const claimable = !delivery
        || (delivery.status === 'failed' && delivery.nextAttemptAtMs <= now)
        || (delivery.status === 'processing' && now - delivery.updatedAtMs >= OUTBOX_STALE_PROCESSING_MS);
      if (!claimable) return null;
      const claimed = {
        eventId, consumer,
        status: 'processing',
        attempts: (delivery ? delivery.attempts : 0) + 1,
        nextAttemptAtMs: null,
        updatedAtMs: now,
      };
      deliveries.set(key, claimed);
      return claimed;
    },

    async complete(eventId, consumer) {
      const key = `${eventId}:${consumer}`;
      const delivery = deliveries.get(key);
      if (delivery) deliveries.set(key, { ...delivery, status: 'completed', updatedAtMs: clock.now() });
    },

    async fail(eventId, consumer, { abandoned, nextAttemptAtMs }) {
      const key = `${eventId}:${consumer}`;
      const delivery = deliveries.get(key);
      if (delivery) {
        deliveries.set(key, {
          ...delivery,
          status: abandoned ? 'abandoned' : 'failed',
          nextAttemptAtMs: abandoned ? null : nextAttemptAtMs,
          updatedAtMs: clock.now(),
        });
      }
    },

    /** Recent events, newest first (Operations Center history). */
    async listRecent({ organizationKey, limit = 100 } = {}) {
      const matches = [];
      for (let i = events.length - 1; i >= 0 && matches.length < limit; i--) {
        if (organizationKey && events[i].organizationKey !== organizationKey) continue;
        matches.push(events[i]);
      }
      return matches;
    },

    async deliveryOf(eventId, consumer) {
      return deliveries.get(`${eventId}:${consumer}`) || null;
    },

    async size() {
      return events.length;
    },
  };
}

/**
 * The outbox processor: registered consumers, bounded retries, isolation.
 * @param {{
 *   store: ReturnType<typeof createInMemoryOutboxStore>,
 *   clock?: import('../handoff/clock').Clock,
 *   telemetry?: { event: Function },
 *   maxAttempts?: number,
 *   backoffMs?: number[],
 * }} deps
 */
function createOutbox({ store, clock = systemClock(), telemetry, maxAttempts = DEFAULT_MAX_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS } = {}) {
  const outboxStore = store || createInMemoryOutboxStore({ clock });
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  /** @type {Array<{ consumer: string, eventTypes: string[]|null, handle: Function }>} */
  const consumers = [];
  let draining = null;

  async function deliverTo(registration, event) {
    const claimed = await outboxStore.claim(event.id, registration.consumer);
    if (!claimed) return; // another processor holds it, or it is settled
    try {
      await registration.handle(event);
      await outboxStore.complete(event.id, registration.consumer);
      emit('outbox.delivered', {
        severity: 'info', component: 'internal', operation: `outbox:${registration.consumer}`,
        code: event.type, organizationKey: event.organizationKey,
        sessionId: event.sessionId ?? undefined, correlationId: event.correlationId ?? undefined,
        attempt: claimed.attempts,
      });
    } catch (err) {
      const abandoned = claimed.attempts >= maxAttempts;
      const backoff = backoffMs[Math.min(claimed.attempts - 1, backoffMs.length - 1)] ?? 0;
      await outboxStore.fail(event.id, registration.consumer, {
        abandoned,
        nextAttemptAtMs: clock.now() + backoff,
      });
      emit(abandoned ? 'outbox.abandoned' : 'outbox.delivery_failed', {
        severity: abandoned ? 'error' : 'warn',
        component: 'internal', operation: `outbox:${registration.consumer}`,
        code: event.type, organizationKey: event.organizationKey,
        sessionId: event.sessionId ?? undefined, correlationId: event.correlationId ?? undefined,
        attempt: claimed.attempts, maxAttempts,
        errorName: err && err.name ? String(err.name) : 'Error',
      });
    }
  }

  const api = {
    store: outboxStore,

    /**
     * Register a consumer: one registration, zero producer changes.
     * @param {{ consumer: string, eventTypes?: string[], handle: (event) => Promise<void> }} registration
     */
    register(registration) {
      if (!registration || typeof registration.consumer !== 'string' || registration.consumer === ''
        || typeof registration.handle !== 'function') {
        throw new TypeError('An outbox consumer must declare a nonblank consumer name and handle().');
      }
      if (consumers.some((c) => c.consumer === registration.consumer)) {
        throw new TypeError(`Outbox consumer already registered: ${registration.consumer}`);
      }
      consumers.push({ eventTypes: null, ...registration });
    },

    consumerNames() {
      return consumers.map((c) => c.consumer);
    },

    /**
     * Process everything pending for every consumer. Serialized: overlapping
     * drains coalesce. Deterministic in tests (no timers).
     */
    async drain() {
      if (draining) return draining;
      draining = (async () => {
        try {
          for (const registration of consumers) {
            const candidates = await outboxStore.claimable(registration.consumer, { limit: 100 });
            for (const event of candidates) {
              if (registration.eventTypes && !registration.eventTypes.includes(event.type)) {
                // Not subscribed: settle immediately so it never re-queues.
                const claimed = await outboxStore.claim(event.id, registration.consumer);
                if (claimed) await outboxStore.complete(event.id, registration.consumer);
                continue;
              }
              await deliverTo(registration, event);
            }
          }
        } finally {
          draining = null;
        }
      })();
      return draining;
    },

    /** Post-commit nudge: fire-and-forget drain on the next tick. */
    drainSoon() {
      setImmediate(() => { api.drain().catch(() => {}); });
    },
  };
  return api;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Real timers, wrapped so tests can inject deterministic ones. */
function systemTimers() {
  return {
    set(fn, ms) { return setTimeout(fn, ms); },
    clear(handle) { clearTimeout(handle); },
  };
}

/**
 * The outbox poller — liveness behind the drain() contract.
 *
 * One timer per process, re-armed only AFTER the previous drain resolves,
 * so poll loops can never overlap in-process (and drain() itself
 * coalesces with post-commit nudges). Across API instances, safety is the
 * store's atomic delivery claims — polling adds no new coordination.
 * The timer is unref'd: the poller never holds the process open.
 *
 * @param {{
 *   outbox: { drain(): Promise<void> },
 *   intervalMs?: number,
 *   timers?: { set(fn, ms): any, clear(handle): void },
 * }} deps
 */
function createOutboxPoller({ outbox, intervalMs = DEFAULT_POLL_INTERVAL_MS, timers = systemTimers() } = {}) {
  if (!outbox || typeof outbox.drain !== 'function') {
    throw new TypeError('The outbox poller needs an outbox exposing drain().');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('The outbox poll interval must be a positive number of milliseconds.');
  }

  let timer = null;
  let running = false;

  function arm() {
    if (!running || timer !== null) return;
    timer = timers.set(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    timer = null;
    try {
      await outbox.drain(); // never rejects by contract; belt and braces:
    } catch { /* a drain failure must never kill the poll loop */ }
    arm(); // re-arm only after the drain resolves — no overlapping loops
  }

  return {
    /** Idempotent. Call after successful application boot. */
    start() {
      if (running) return;
      running = true;
      arm();
    },
    /** Idempotent. Clears the timer; leaves no handles behind. */
    stop() {
      running = false;
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
    },
    isRunning() {
      return running;
    },
  };
}

module.exports = {
  createOutbox,
  createInMemoryOutboxStore,
  createOutboxPoller,
  validateEvent,
  OUTBOX_STALE_PROCESSING_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
};
