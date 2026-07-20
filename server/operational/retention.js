'use strict';

/**
 * Data retention sweep (ADR-0006 / GitLab #63) — the automated purge that
 * ADR-0006 deferred. It enforces the retention windows by HARD-DELETING
 * operational sessions past their window, organization-scoped:
 *
 *   - cancelled / expired sessions after `cancelledExpiredHours` (default 24);
 *   - terminal sessions (booked/failed/escalated) after `terminalDays`
 *     (default 30) — the delivered consultation summary email is the
 *     durable record of account (ADR-0006), rendered summaries are never
 *     stored.
 *
 * Windows are ADR-0006's PROPOSED defaults, organization-overridable via
 * the Customer Configuration Framework (`data-retention` domain). The
 * sweep runs on the existing liveness poller (the same seam as the outbox
 * drain and the alerting evaluate) — no competing scheduler. It is
 * deterministic and idempotent: the store deletes set-based by age, so a
 * second sweep in the same window deletes nothing new. Telemetry carries
 * COUNTS ONLY — never caller data.
 */

const { readDomain } = require('../configuration/framework');

const DEFAULT_POLICY = Object.freeze({ cancelledExpiredHours: 24, terminalDays: 30 });
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * @param {{
 *   store: object,                    handoff store (both implementations)
 *   configService: object|null,       for per-organization overrides
 *   clock: import('../handoff/clock').Clock,
 *   telemetry?: { event: Function },
 * }} deps
 */
function createRetentionService({ store, configService = null, clock, telemetry }) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  function policyFor(organizationKey) {
    if (!configService) return { ...DEFAULT_POLICY };
    const { value } = readDomain(configService, 'data-retention', organizationKey);
    return value || { ...DEFAULT_POLICY };
  }

  /** Organizations to sweep: every configured firm (bounded; pilot = one). */
  function organizations() {
    if (!configService) return [];
    try {
      return configService.organizations.list().map((o) => o.key);
    } catch {
      return [];
    }
  }

  return {
    /**
     * Run one retention sweep across all organizations. Safe to call
     * repeatedly (the poller does). Never throws — retention must not break
     * the poller; a per-organization failure is isolated and logged.
     * @returns {Promise<{ purgedShortLived: number, purgedTerminal: number }>}
     */
    async sweep() {
      const now = clock.now();
      let purgedShortLived = 0;
      let purgedTerminal = 0;
      for (const organizationKey of organizations()) {
        try {
          const policy = policyFor(organizationKey);
          const result = await store.purgeRetired(organizationKey, {
            cancelledExpiredBeforeMs: now - policy.cancelledExpiredHours * HOUR_MS,
            terminalBeforeMs: now - policy.terminalDays * DAY_MS,
          });
          if (result.purgedShortLived > 0 || result.purgedTerminal > 0) {
            emit('retention.swept', {
              severity: 'info',
              component: 'operational-store',
              operation: 'retention-sweep',
              organizationKey,
              purgedShortLived: result.purgedShortLived,
              purgedTerminal: result.purgedTerminal,
            });
          }
          purgedShortLived += result.purgedShortLived;
          purgedTerminal += result.purgedTerminal;
        } catch (err) {
          emit('internal.unexpected_error', {
            severity: 'error', component: 'operational-store', operation: 'retention-sweep',
            organizationKey,
          });
        }
      }
      return { purgedShortLived, purgedTerminal };
    },
  };
}

module.exports = { createRetentionService, DEFAULT_POLICY };
