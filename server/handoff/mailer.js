'use strict';

/**
 * GuideHerd mailer boundary — Microsoft Graph implementation.
 *
 * The rest of the platform talks to this boundary in GuideHerd terms
 * ("deliver this Consultation Summary"); Microsoft Graph is an implementation
 * detail behind it and can be replaced without touching callers.
 *
 * Uses native fetch (no dependencies). The application starts and tests run
 * without real Microsoft credentials: when configuration is missing the
 * mailer is disabled and returns a controlled 'not-configured' result —
 * it never crashes unrelated API operations.
 *
 * ── Failure classification and retry (Issue #8) ────────────────────────────
 *
 * Provider failures are translated HERE into the GuideHerd taxonomy
 * (provider_* categories); Graph vocabulary never crosses this boundary.
 * Bounded retries apply ONLY to failures where the message provably was
 * not accepted — a duplicate Consultation Summary email is worse than a
 * delayed one:
 *
 *   RETRIED (message was not accepted):
 *     429 rate limited · 503 unavailable · connection-phase failures
 *     (refused / DNS) on either the token or send request
 *   NOT RETRIED (ambiguous or permanent):
 *     timeouts and connection resets (the request may have been accepted
 *     before the failure) · other 5xx (acceptance state unknown) ·
 *     401/403 (credentials wrong — retrying cannot help) ·
 *     other 4xx (request rejected — retrying identical input cannot help)
 *
 * Ambiguous/permanent failures still resolve to { status: 'failed' }: the
 * repository's summary-delivery claim state machine (ADR-0006) remains the
 * retry-LATER path, with 'sent' finality guaranteeing no duplicate sends.
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

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
const SEND_URL = (mailbox) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;

/** Graph's request id header — a safe SECONDARY reference for diagnostics. */
function graphRequestId(res) {
  try {
    return res.headers.get('request-id') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a fetch() rejection. Connection-phase failures (the request
 * never reached the provider) are retryable; anything ambiguous is not.
 */
function classifyNetworkError(err) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return providerUnavailable({ provider: PROVIDER, retryable: true });
  }
  if (['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ABORT_ERR'].includes(code) || (err && err.name === 'AbortError')) {
    return providerTimeout({ provider: PROVIDER, retryable: false }); // ambiguous: may have been accepted
  }
  // Resets and everything else mid-flight: acceptance state unknown.
  return providerTimeout({ provider: PROVIDER, retryable: false });
}

/** Classify a non-success HTTP response from the provider. */
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
 *   fetchImpl?: typeof fetch,   // injected in tests; never call real Graph there
 *   telemetry?: { event: Function },
 *   sleep?: (ms: number) => Promise<void>,   // injected in tests; no real sleeps
 *   retryAttempts?: number,
 * }} [deps]
 */
function createMailer({ env = process.env, fetchImpl = fetch, telemetry, sleep, retryAttempts = 3 } = {}) {
  const config = {
    tenantId: env.MS_TENANT_ID,
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    mailbox: env.SUMMARY_MAILBOX,
    recipient: env.SUMMARY_RECIPIENT,
  };
  const enabled = Boolean(
    config.tenantId && config.clientId && config.clientSecret && config.mailbox && config.recipient,
  );
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
      // Token-endpoint failures: 429/5xx are provider-side (retry-safe — no
      // mail was sent); anything else means credentials/config (permanent).
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
    enabled,

    /**
     * Deliver a Consultation Summary. Resolves to:
     *   { status: 'sent' }            — Graph accepted the message (HTTP 202)
     *   { status: 'failed' }          — delivery failed (retry permitted later)
     *   { status: 'not-configured' }  — mail configuration absent; controlled no-op
     * Never throws; never logs credentials or message content.
     * @param {{ subject: string, html: string }} message
     * @param {{ correlationId?: string, organizationKey?: string, sessionId?: string }} [context]
     */
    async sendSummary({ subject, html }, context = {}) {
      if (!enabled) return { status: 'not-configured' };
      const eventFields = {
        component: 'email-provider',
        operation: 'summary-delivery',
        provider: PROVIDER,
        correlationId: context.correlationId,
        organizationKey: context.organizationKey,
        sessionId: context.sessionId,
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
                  subject,
                  body: { contentType: 'HTML', content: html },
                  toRecipients: [{ emailAddress: { address: config.recipient } }],
                },
                saveToSentItems: true,
              }),
            });
          } catch (err) {
            throw classifyNetworkError(err);
          }
          // Graph confirms acceptance with 202. Anything else is a failure.
          if (res.status === 202) return { status: 'sent' };
          throw classifyHttpFailure(res);
        }, {
          attempts: retryAttempts,
          backoffMs: [200, 800],
          sleep,
          onEvent: emit,
          fields: eventFields,
        });
      } catch (err) {
        // Provider-categorized failure: one final safe diagnostic event,
        // then the boundary's stable contract — { status: 'failed' }.
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
        emit('summary.delivery_failed', { ...eventFields, severity: 'error', category: err && err.category ? err.category : 'provider_unavailable' });
        return { status: 'failed' };
      }
    },
  };
}

module.exports = { createMailer };
