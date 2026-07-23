'use strict';

/**
 * GuideHerd operational telemetry (Issue #8) — the centralized structured
 * event surface.
 *
 * One emitter, a closed catalog of GuideHerd-owned event names, and a
 * strict field allowlist: an event can only ever carry identifiers and
 * decision facts. Unknown fields are DROPPED (never logged), so a call
 * site cannot accidentally leak caller PII, tokens, credentials, or raw
 * provider payloads through telemetry. Values are emitted as single-line
 * JSON on stdout — the platform's existing Railway logging convention
 * (structured JSON; the log viewer renders `message`/attributes and
 * events are queryable with `@field:value`).
 *
 * This module GENERATES telemetry. Persistence and display belong to the
 * Operations Dashboard ticket (Issue #22) and deliberately do not exist
 * here — the event shape below is the contract that work will consume.
 *
 * Never emitted: bearer/capability tokens, Authorization headers, API
 * keys, raw provider payloads, transcripts, recordings, caller names,
 * phone numbers, email addresses, legal narratives, or unsanitized stack
 * traces. Stacks are logged only for unexpected internal errors, with the
 * message line removed (frames carry file paths and line numbers only).
 */

const { systemClock } = require('../handoff/clock');

/** The closed event catalog. Names are stable — Issue #22 will key on them. */
const EVENTS = Object.freeze([
  'request.failed',
  'validation.failed',
  'authorization.denied', // primary emission lives in identity/authorization.js
  'correlation.failed',
  'provider.unavailable',
  'provider.timeout',
  'provider.authentication_failed',
  'provider.rate_limited',
  'provider.rejected_request',
  'scheduling.availability_failed',
  'booking.failed',
  'outcome.failed',
  'summary.generation_failed',
  'summary.delivery_failed',
  'retry.attempted',
  'retry.exhausted',
  'internal.unexpected_error',
  'notification.delivered',
  'notification.delivery_failed',
  'notification.suppressed',
  'authentication.login',
  'authentication.login_failed',
  'authentication.logout',
  // Administration Framework (ADR-0015 §4): emitted on every administered
  // write since the framework shipped, but missing from this catalog until
  // the #65 review — the documented event was being dropped as
  // unknown_event on every configuration change.
  'configuration.changed',
  'outbox.delivered',
  'outbox.delivery_failed',
  'outbox.abandoned',
  'integration.delivered',
  'integration.delivery_failed',
  'integration.suppressed',
  'workflow.instance_started',
  'workflow.transitioned',
  'workflow.completed',
  'workflow.step_failed',
  'workflow.step_abandoned',
  // Live slot selection (ADR-0012 / #66): policy + business hours
  // governing real offers, and the loud everything-excluded case.
  'scheduling.slots_selected',
  'scheduling.slots_exhausted',
  // Consolidated offered-slots: per-check timing + counts, and the
  // diagnostic policy-bypass detector (a booked outcome with no
  // offered-slots call for the session).
  'scheduling.slots_offered',
  'scheduling.policy_bypass_suspected',
  // Data retention (ADR-0006 / #63): one event per sweep, counts only.
  'retention.swept',
  // Failure alerting (#68): raised conditions are ALWAYS loud here,
  // independent of whether (or how) the alert email is delivered.
  'alert.raised',
  'alert.recovered',
  'scheduler.action_scheduled',
  'scheduler.action_completed',
  'scheduler.action_failed',
  'scheduler.action_expired',
]);

/** GuideHerd component names for failure attribution. */
const COMPONENTS = Object.freeze([
  'http-api',
  'scheduling',
  'identity',
  'authorization',
  'configuration-store',
  'operational-store',
  'handoff',
  'connect',
  'correlation-engine',
  'scheduling-provider',
  'calendar-provider',
  'email-provider',
  'communication-provider',
  'internal',
]);

/**
 * The only fields an event may carry. Everything else is dropped.
 * All values are identifiers, enums, or small numbers — never free text
 * from a request, a caller, or a provider.
 */
const ALLOWED_FIELDS = Object.freeze([
  'correlationId',
  'organizationKey',
  'subject',
  'component',
  'operation',
  'severity',
  'category',
  'retryable',
  'attempt',
  'maxAttempts',
  'httpStatus',
  'provider',
  'providerRequestId',
  'sessionId',
  // Retention sweep counts (#63): small integers, never caller data.
  'purgedShortLived',
  'purgedTerminal',
  // Slot-selection counts (#66) + alert occurrence count (#68): small
  // numbers, never slot content or caller data.
  'receivedCount',
  'offeredCount',
  'removedCount',
  // Offered-slots timing components: small millisecond integers measured
  // server-side, never content. Provider timing splits header arrival
  // from body completion (finer network phases are not observable
  // through fetch).
  'configMs',
  'providerMs',
  'providerHeadersMs',
  'providerBodyMs',
  'rankMs',
  'totalMs',
  'inWindowCount',
  'status',
  'count',
  'code',
  'notificationType',
  'notificationKey',
  'integrationType',
  'integrationKey',
  'workflowType',
  'instanceId',
  'stepKey',
  'fromState',
  'toState',
  'intent',
  'actionType',
  'actionKey',
  'scheduleSlot',
  'runAt',
  'errorName',
  'stack',
  'method',
  'path',
]);

const SEVERITIES = Object.freeze(['info', 'warn', 'error']);

/**
 * Sanitize an unexpected error for internal logging: the error's NAME and
 * its stack FRAMES only. The message line is removed — messages can echo
 * request data; frames carry only file paths and line numbers.
 * @param {unknown} err
 * @returns {{ errorName: string, stack: string|null }}
 */
function sanitizeError(err) {
  const errorName = err && err.name ? String(err.name) : 'Error';
  let stack = null;
  if (err && typeof err.stack === 'string') {
    stack = err.stack
      .split('\n')
      .filter((line) => line.trimStart().startsWith('at '))
      .slice(0, 8)
      .map((line) => line.trim())
      .join(' | ') || null;
  }
  return { errorName, stack };
}

/**
 * @param {{ log?: (line: string) => void, clock?: import('../handoff/clock').Clock }} [deps]
 */
function createTelemetry({ log = console.log, clock = systemClock() } = {}) {
  return {
    /**
     * Emit one structured operational event. Never throws — telemetry can
     * never break a workflow.
     * @param {string} name an EVENTS catalog name
     * @param {object} [fields] safe fields (unknown keys are dropped)
     */
    event(name, fields = {}) {
      try {
        if (!EVENTS.includes(name)) {
          // A typo'd event name must be visible, not silently absent.
          log(JSON.stringify({
            level: 'error',
            event: 'guideherd.telemetry.unknown_event',
            attempted: String(name).slice(0, 64),
            at: new Date(clock.now()).toISOString(),
          }));
          return;
        }
        const entry = {
          level: SEVERITIES.includes(fields.severity) ? fields.severity : 'warn',
          event: `guideherd.${name}`,
          at: new Date(clock.now()).toISOString(),
        };
        for (const key of ALLOWED_FIELDS) {
          if (key === 'severity') continue; // carried as `level`
          if (fields[key] !== undefined && fields[key] !== null) entry[key] = fields[key];
        }
        log(JSON.stringify(entry));
      } catch {
        // Telemetry failures are absorbed: the workflow always wins.
      }
    },
  };
}

module.exports = { createTelemetry, sanitizeError, EVENTS, COMPONENTS, ALLOWED_FIELDS };
