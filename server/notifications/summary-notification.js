'use strict';

/**
 * The Consultation Summary as a first-class notification type (ADR-0011 §8).
 *
 * The summary was the last outbound communication delivered outside the
 * Notification Contract: the conversation workflow rendered HTML and
 * called the Graph mailer directly. This module completes the migration.
 * The conversation workflow now states an INTENT ("deliver this session's
 * consultation summary") and the Notification Contract owns everything
 * after that: type, template, idempotency, provider selection, delivery,
 * and telemetry.
 *
 * Three deliberate design points:
 *
 * 1. WORDING IS PRESERVED BYTE FOR BYTE. The renderer registered here
 *    delegates to the existing `summarySubject`/`renderSummaryHtml`
 *    domain artifact (handoff/summary.js) — the migration moves WHERE
 *    rendering is decided, not WHAT is rendered. (The summary remains a
 *    GuideHerd-branded internal document by design; `resolveBranding`
 *    still runs and future summary templates may consume it.)
 *
 * 2. THE DELIVERY TARGET IS THE FIRM, not the caller. The summary goes to
 *    the firm's configured summary mailbox, owned by the existing Graph
 *    mailer boundary (SUMMARY_RECIPIENT) with its duplication-safe retry
 *    policy. `createSummaryMailerProvider` puts that boundary behind the
 *    provider contract — reusing the existing Graph implementation, not
 *    rewriting it. This is why `recipient` is optional for model types.
 *
 * 3. LAYERED IDEMPOTENCY. The session row's summary-delivery claim
 *    (repository) remains the workflow-level guard and the source of the
 *    synchronous `summaryDelivery` response field; the notification
 *    delivery claim (`consultation-summary:<sessionId>`) is the
 *    notification-level exactly-once guarantee. Both are atomic; any
 *    interleaving of duplicate requests, instances, or the recovery
 *    consumer converges on at most one delivered email.
 */

const { buildConsultationSummary, renderSummaryHtml, summarySubject } = require('../handoff/summary');
const { registerNotificationRenderer } = require('./templates');

const SUMMARY_TYPE = 'consultation-summary';
const SUMMARY_PROVIDER_KEY = 'summary-mailer';

/** The notification key: one logical summary per session, ever. */
function summaryNotificationKey(sessionId) {
  return `${SUMMARY_TYPE}:${sessionId}`;
}

/** Plain-text alternative (contract shape only; the mailer sends HTML). */
function summaryText(model) {
  const lines = [
    'GuideHerd Consultation Summary',
    '',
    `Caller: ${model.caller.fullName}`,
    `Email: ${model.caller.email}`,
  ];
  if (model.caller.phone) lines.push(`Phone: ${model.caller.phone}`);
  lines.push(`Outcome: ${model.outcome.status}`);
  if (model.outcome.appointmentStartsAt) lines.push(`Appointment: ${model.outcome.appointmentStartsAt} (${model.outcome.timezone})`);
  if (model.notes.schedulingSummary) lines.push('', model.notes.schedulingSummary);
  return lines.join('\n');
}

/**
 * Register the consultation-summary template: ONE registration, and the
 * Notification Contract renders the type — the extension point ADR-0011
 * promised. Idempotent (re-registration replaces).
 */
function registerConsultationSummaryTemplate() {
  registerNotificationRenderer(SUMMARY_TYPE, (request) => {
    const model = request.model;
    return {
      subject: summarySubject(model),
      html: renderSummaryHtml(model),
      text: summaryText(model),
    };
  });
}

/**
 * The summary delivery provider: the existing Graph mailer boundary
 * (firm-facing summary mailbox, duplication-safe retries, taxonomy-
 * classified failures) behind the notification provider contract. The
 * provider only delivers what the contract rendered — no decisions.
 * @param {{ mailer: { enabled: boolean, sendSummary: Function } }} deps
 */
function createSummaryMailerProvider({ mailer }) {
  return {
    providerKey: SUMMARY_PROVIDER_KEY,
    get enabled() {
      return Boolean(mailer && mailer.enabled);
    },
    async deliver({ rendered }, context = {}) {
      return mailer.sendSummary(
        { subject: rendered.subject, html: rendered.html },
        {
          correlationId: context.correlationId,
          organizationKey: context.organizationKey,
          sessionId: context.sessionId,
        },
      );
    },
  };
}

/**
 * The conversation workflow's entire view of summary delivery: state the
 * intent, get a status back. No templates, no HTML, no providers, no
 * Graph, no retry policy — those all live behind the Notification
 * Contract now.
 *
 * @param {{ notificationService: { send: Function }, telemetry?: { event: Function } }} deps
 * @returns {{ deliver(session, context): Promise<{ status: 'sent'|'failed'|'not-configured' }> }}
 */
function createSummaryNotifier({ notificationService, telemetry }) {
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};
  return {
    async deliver(session, context = {}) {
      let model;
      try {
        model = buildConsultationSummary(session);
      } catch (err) {
        // A generation failure records 'failed' (retry permitted later),
        // emits a safe diagnostic, and never disturbs the outcome —
        // identical semantics to the pre-migration flow.
        emit('summary.generation_failed', {
          severity: 'error',
          component: 'handoff',
          operation: 'summary-generation',
          category: 'permanent_internal_failure',
          correlationId: context.correlationId,
          organizationKey: context.organizationKey ?? session.firmId,
          sessionId: session.sessionId,
          errorName: err && err.name ? String(err.name) : 'Error',
        });
        return { status: 'failed' };
      }

      const result = await notificationService.send({
        type: SUMMARY_TYPE,
        organizationKey: context.organizationKey ?? session.firmId,
        notificationKey: summaryNotificationKey(session.sessionId),
        model,
      }, { correlationId: context.correlationId, sessionId: session.sessionId });

      // 'suppressed' means the notification layer already settled this key
      // (e.g. a prior attempt recorded 'sent' but the session mirror was
      // lost mid-crash): the customer-visible effect exists, report it.
      if (result.status === 'suppressed') {
        return { status: result.suppressedBy === 'sent' ? 'sent' : 'failed' };
      }
      return { status: result.status };
    },
  };
}

/**
 * The durable recovery consumer (ADR-0017): closes the crash gap between
 * an outcome committing and the summary attempt starting. It consumes
 * `conversation.completed` for EVERY terminal status (summaries are sent
 * for booked, failed, and escalated alike) and acts ONLY when no summary
 * attempt was ever recorded:
 *
 *   - a terminal summary state ('sent'/'failed'/'not-configured') settles
 *     the event silently — the inline path already ran, and the
 *     documented retry path (an identical outcome report re-claims after
 *     'failed') is preserved exactly: no background auto-retry appears;
 *   - a null state means the process died before claiming — recover;
 *   - a fresh 'pending' claim means an attempt is in flight elsewhere —
 *     the outbox redelivers with backoff, by which point the claim is
 *     either terminal (settle) or stale (the atomic claim re-grants).
 *
 * Both this consumer and the inline path pass through the SAME atomic
 * session claim and the SAME notification key, so no interleaving can
 * produce a second email.
 */
function registerSummaryRecovery({ outbox, store, summaryNotifier }) {
  outbox.register({
    consumer: SUMMARY_TYPE,
    eventTypes: ['conversation.completed'],
    async handle(event) {
      const session = await store.get(event.sessionId);
      if (!session) return; // session expired/removed: nothing to recover
      const state = session.summaryDelivery ?? null;
      if (state !== null && state !== 'pending') return; // attempt already ran

      const claim = await store.claimSummaryDelivery(event.sessionId);
      if (!claim.claimed) {
        if ((claim.summaryDelivery ?? null) === 'pending') {
          throw new Error('summary delivery in progress; retry'); // outbox backoff re-checks
        }
        return; // settled terminally between the check and the claim
      }
      const result = await summaryNotifier.deliver(claim.session, {
        correlationId: event.correlationId ?? undefined,
        organizationKey: event.organizationKey,
        sessionId: event.sessionId,
      });
      await store.recordSummaryDelivery(event.sessionId, result.status);
    },
  });
}

module.exports = {
  SUMMARY_TYPE,
  SUMMARY_PROVIDER_KEY,
  summaryNotificationKey,
  registerConsultationSummaryTemplate,
  createSummaryMailerProvider,
  createSummaryNotifier,
  registerSummaryRecovery,
};
