'use strict';

/**
 * Microsoft Graph Email — the first Notification Provider (ADR-0011).
 *
 * Translates one rendered, branded GuideHerd notification into a Graph
 * sendMail call and delivers it. Nothing more: recipients, timing,
 * content, and branding were decided by Core before this boundary, and
 * Graph vocabulary never crosses back — failures are classified into the
 * GuideHerd taxonomy (Issue #8) and surface only as telemetry plus the
 * neutral { status } result.
 *
 * Retry policy mirrors the mailer boundary's duplication-safety rule: a
 * duplicate customer email is worse than a delayed one, so only failures
 * where the message provably was NOT accepted are retried (429, 503,
 * connection-phase); timeouts, resets, and other 5xx are ambiguous and
 * resolve to 'failed' — the delivery store's claim state machine is the
 * retry-later path, and 'sent' finality suppresses any re-send.
 *
 * Configuration (deployment environment; secrets never in configuration
 * data): the same MS_* variables as the Consultation Summary mailer, and
 * NOTIFICATION_MAILBOX (falling back to SUMMARY_MAILBOX) as the sending
 * mailbox. The sender display name is the mailbox's own; per-firm sender
 * identity (a firm-named mailbox or domain) is a deployment concern
 * documented in ADR-0011, not a payload trick.
 *
 * Never logged: credentials, tokens, message bodies, recipient content.
 */

const {
  providerUnavailable,
  providerTimeout,
  providerAuthenticationFailed,
  providerRateLimited,
  providerRejectedRequest,
} = require('../telemetry/provider-errors');
const { withRetry } = require('../telemetry/retry');

const PROVIDER = 'microsoft-graph';
const PROVIDER_KEY = 'graph-email';

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
const SEND_URL = (mailbox) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;

function graphRequestId(res) {
  try {
    return res.headers.get('request-id') || undefined;
  } catch {
    return undefined;
  }
}

function classifyNetworkError(err) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return providerUnavailable({ provider: PROVIDER, retryable: true });
  }
  return providerTimeout({ provider: PROVIDER, retryable: false }); // ambiguous: may have been accepted
}

function classifyHttpFailure(res) {
  const facts = { provider: PROVIDER, httpStatus: res.status, providerRequestId: graphRequestId(res) };
  if (res.status === 429) return providerRateLimited({ ...facts, retryable: true });
  if (res.status === 401 || res.status === 403) return providerAuthenticationFailed({ ...facts, retryable: false });
  if (res.status === 503) return providerUnavailable({ ...facts, retryable: true });
  if (res.status >= 500) return providerUnavailable({ ...facts, retryable: false }); // acceptance ambiguous
  return providerRejectedRequest({ ...facts, retryable: false });
}

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetchImpl?: typeof fetch,
 *   telemetry?: { event: Function },
 *   sleep?: (ms: number) => Promise<void>,
 *   retryAttempts?: number,
 * }} [deps]
 */
function createGraphEmailProvider({ env = process.env, fetchImpl = fetch, telemetry, sleep, retryAttempts = 3 } = {}) {
  const config = {
    tenantId: env.MS_TENANT_ID,
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    mailbox: env.NOTIFICATION_MAILBOX || env.SUMMARY_MAILBOX,
  };
  const enabled = Boolean(config.tenantId && config.clientId && config.clientSecret && config.mailbox);
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  async function acquireToken() {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    let res;
    try {
      res = await fetchImpl(TOKEN_URL(config.tenantId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }
    if (!res.ok) {
      if (res.status === 429) throw providerRateLimited({ provider: PROVIDER, httpStatus: res.status, retryable: true });
      if (res.status >= 500) throw providerUnavailable({ provider: PROVIDER, httpStatus: res.status, retryable: true });
      throw providerAuthenticationFailed({ provider: PROVIDER, httpStatus: res.status, retryable: false });
    }
    const json = await res.json();
    if (!json || typeof json.access_token !== 'string') {
      throw providerRejectedRequest({ provider: PROVIDER, retryable: false });
    }
    return json.access_token;
  }

  return {
    providerKey: PROVIDER_KEY,
    enabled,

    /**
     * Deliver one rendered, branded notification.
     * @param {{ rendered: { subject: string, html: string, text: string },
     *           recipient: { name: string|null, email: string },
     *           branding: object }} message
     * @param {{ correlationId?: string, organizationKey?: string, sessionId?: string,
     *           notificationType?: string, notificationKey?: string }} [context]
     * @returns {Promise<{ status: 'sent'|'failed'|'not-configured', providerRequestId?: string }>}
     */
    async deliver({ rendered, recipient }, context = {}) {
      if (!enabled) return { status: 'not-configured' };
      const eventFields = {
        component: 'email-provider',
        operation: 'notification-delivery',
        provider: PROVIDER,
        correlationId: context.correlationId,
        organizationKey: context.organizationKey,
        sessionId: context.sessionId,
        notificationType: context.notificationType,
        notificationKey: context.notificationKey,
      };
      try {
        return await withRetry(async () => {
          const token = await acquireToken();
          let res;
          try {
            res = await fetchImpl(SEND_URL(config.mailbox), {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: {
                  subject: rendered.subject,
                  body: { contentType: 'HTML', content: rendered.html },
                  toRecipients: [{
                    emailAddress: recipient.name
                      ? { address: recipient.email, name: recipient.name }
                      : { address: recipient.email },
                  }],
                },
                saveToSentItems: true,
              }),
            });
          } catch (err) {
            throw classifyNetworkError(err);
          }
          if (res.status === 202) return { status: 'sent', providerRequestId: graphRequestId(res) };
          throw classifyHttpFailure(res);
        }, {
          attempts: retryAttempts,
          backoffMs: [200, 800],
          sleep,
          onEvent: emit,
          fields: eventFields,
        });
      } catch (err) {
        const eventName = {
          provider_timeout: 'provider.timeout',
          provider_unavailable: 'provider.unavailable',
          provider_authentication_failed: 'provider.authentication_failed',
          provider_rate_limited: 'provider.rate_limited',
          provider_rejected_request: 'provider.rejected_request',
        }[err && err.category] || 'provider.unavailable';
        emit(eventName, {
          ...eventFields,
          severity: 'error',
          category: err && err.category ? err.category : 'provider_unavailable',
          retryable: Boolean(err && err.retryable),
          httpStatus: err && err.httpStatus ? err.httpStatus : undefined,
          providerRequestId: err && err.providerRequestId ? err.providerRequestId : undefined,
        });
        return { status: 'failed' };
      }
    },
  };
}

module.exports = { createGraphEmailProvider, PROVIDER_KEY };
