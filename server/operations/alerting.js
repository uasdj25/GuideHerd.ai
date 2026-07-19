'use strict';

/**
 * Failure alerting (GitLab #68) — silent failures reach an administrator.
 *
 * Built ON the existing contracts, never beside them: alerts are ordinary
 * notifications (`operational-alert`, ADR-0011) so the claim machine gives
 * every alert structural exactly-once-per-condition-window delivery — a
 * storm is impossible by construction, not by throttling code. Conditions
 * are observed from seams that already exist:
 *
 *   - the DURABLE outbox event `conversation.completed` (at-least-once,
 *     restart-safe) for failed handoff outcomes — aggregated to a
 *     threshold per window so one blip never pages anyone;
 *   - the telemetry seam for `notification.delivery_failed` after
 *     exhausted retries — excluding the alert type itself (no feedback
 *     loop) and excluding `provider_not_configured` (the capability
 *     condition owns configuration state);
 *   - `evaluate()` (driven by the existing poller) for capability
 *     DEGRADATION: baseline-then-edge — the first evaluation records
 *     current state without alerting (a capability that boots dark is
 *     already visible on the Operations Center), and a runtime transition
 *     into `unavailable`/`not-configured` raises once; recovery emits
 *     `alert.recovered`.
 *
 * Independence from the mail system: every raised condition emits loud
 * structured telemetry (`alert.raised`, error) BEFORE any delivery
 * attempt, and that event reaches the Operations Center feed through the
 * observed-telemetry seam — an alert about mail failing never depends on
 * mail to be seen.
 *
 * Per-organization recipient configuration lives in the Customer
 * Configuration Framework (`operational-alerts` domain), DEFAULT OFF.
 * Alert content is condition names, counts, and session identifiers —
 * never caller PII (the Operations Center's privacy posture).
 */

const { readDomain } = require('../configuration/framework');

const ALERT_TYPE = 'operational-alert';
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_FAILED_OUTCOME_THRESHOLD = 3;
const DEGRADED_STATUSES = ['unavailable', 'not-configured'];

/**
 * @param {{
 *   notifications: { send: Function },
 *   configService: object|null,
 *   clock: import('../handoff/clock').Clock,
 *   telemetry?: { event: Function },
 *   healthReport?: () => Promise<{ health: {capability: string, status: string}[] }>,
 *   windowMs?: number,
 *   failedOutcomeThreshold?: number,
 * }} deps
 */
function createAlertingService({
  notifications, configService = null, clock, telemetry,
  healthReport = null,
  windowMs = DEFAULT_WINDOW_MS,
  failedOutcomeThreshold = DEFAULT_FAILED_OUTCOME_THRESHOLD,
}) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  const bucket = () => Math.floor(clock.now() / windowMs);

  // Process-local aggregation state. Honest boundary: counters reset on
  // restart (worst case: a window's threshold counts from zero again);
  // the DELIVERED-alert dedup is durable via the notification claim store.
  const failedOutcomes = new Map(); // organizationKey -> { bucket, count }
  /** @type {Map<string, string>|null} capability -> last status; null = no baseline yet */
  let capabilityBaseline = null;

  function alertConfig(organizationKey) {
    if (!configService) return { enabled: false, recipient: null };
    const { value } = readDomain(configService, 'operational-alerts', organizationKey);
    return value || { enabled: false, recipient: null };
  }

  /**
   * Raise one condition for one organization: loud telemetry ALWAYS;
   * email only when the organization enabled alerting — deduplicated per
   * condition-window by the notification claim machine.
   */
  async function raise(condition, organizationKey, model) {
    emit('alert.raised', {
      severity: 'error',
      component: 'internal',
      operation: 'failure-alerting',
      organizationKey,
      code: condition,
      count: model.count,
    });
    const config = alertConfig(organizationKey);
    if (!config.enabled || !config.recipient) return { status: 'not-configured' };
    return notifications.send({
      type: ALERT_TYPE,
      organizationKey,
      notificationKey: `${ALERT_TYPE}:${condition}:${organizationKey}:${bucket()}`,
      recipient: { email: config.recipient },
      model: { condition, ...model },
    });
  }

  /** Organizations that opted in (capability conditions notify each). */
  function enabledOrganizations() {
    if (!configService) return [];
    try {
      return configService.organizations.list()
        .map((o) => o.key)
        .filter((key) => {
          const config = alertConfig(key);
          return config.enabled && config.recipient;
        });
    } catch {
      return [];
    }
  }

  return {
    /**
     * Durable outbox consumer registration (ADR-0017): failed handoff
     * outcomes aggregate to a threshold per window.
     */
    outboxConsumer() {
      return {
        consumer: 'failure-alerting',
        eventTypes: ['conversation.completed'],
        handle: async (event) => {
          if (!event || !event.payload || event.payload.status !== 'failed') return;
          const organizationKey = event.organizationKey;
          if (!organizationKey) return;
          const current = failedOutcomes.get(organizationKey);
          const b = bucket();
          const next = current && current.bucket === b
            ? { bucket: b, count: current.count + 1 }
            : { bucket: b, count: 1 };
          failedOutcomes.set(organizationKey, next);
          if (next.count === failedOutcomeThreshold) {
            await raise('handoff-outcomes-failing', organizationKey, {
              count: next.count,
              windowMinutes: Math.round(windowMs / 60000),
              sessionId: event.sessionId || null,
            });
          }
        },
      };
    },

    /**
     * Telemetry observer (wired at the observed-telemetry seam): exhausted
     * notification deliveries. Never throws — observability cannot break
     * a workflow.
     */
    observe(name, fields = {}) {
      try {
        if (name !== 'notification.delivery_failed') return;
        if (fields.notificationType === ALERT_TYPE) return; // no feedback loop
        if (fields.code === 'provider_not_configured') return; // capability condition owns this
        if (!fields.organizationKey) return;
        // Fire-and-forget: the claim machine dedups within the window.
        void raise('notification-delivery-failed', fields.organizationKey, {
          count: 1,
          notificationType: fields.notificationType || null,
          sessionId: fields.sessionId || null,
        }).catch(() => {});
      } catch { /* observability never breaks a workflow */ }
    },

    /**
     * Capability degradation, baseline-then-edge. Driven by the existing
     * poller cadence; safe to call repeatedly.
     */
    async evaluate() {
      if (!healthReport) return;
      let health;
      try {
        ({ health } = await healthReport());
      } catch {
        return; // the health surface degrading is its own loud story
      }
      const current = new Map(health.map((h) => [h.capability, h.status]));
      if (capabilityBaseline === null) {
        capabilityBaseline = current; // first look: record, never alert
        return;
      }
      const previous = capabilityBaseline;
      capabilityBaseline = current;
      for (const [capability, status] of current) {
        const before = previous.get(capability);
        if (before === undefined || before === status) continue;
        const wasDegraded = DEGRADED_STATUSES.includes(before);
        const isDegraded = DEGRADED_STATUSES.includes(status);
        if (!wasDegraded && isDegraded) {
          const recipients = enabledOrganizations();
          for (const organizationKey of recipients) {
            await raise(`capability-degraded:${capability}`, organizationKey, {
              count: 1, capability, status,
            });
          }
          if (recipients.length === 0) {
            // Still loud, even with nobody opted in.
            emit('alert.raised', {
              severity: 'error', component: 'internal', operation: 'failure-alerting',
              code: `capability-degraded:${capability}`, count: 1,
            });
          }
        } else if (wasDegraded && !isDegraded) {
          emit('alert.recovered', {
            severity: 'info', component: 'internal', operation: 'failure-alerting',
            code: `capability-recovered:${capability}`,
          });
        }
      }
    },
  };
}

module.exports = { createAlertingService, ALERT_TYPE, DEFAULT_WINDOW_MS, DEFAULT_FAILED_OUTCOME_THRESHOLD };
