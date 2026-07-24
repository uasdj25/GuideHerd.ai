'use strict';

/**
 * Microsoft Graph calendar authentication (GitLab #83) — the connection,
 * consent, and token layer behind the Graph calendar provider
 * (#84–#87). Customers interact with "connect your Microsoft calendar";
 * everything Graph-specific stays behind the ADR-0024 provider boundary.
 *
 * Model (documented in docs/operations/microsoft-graph-calendar.md):
 *   - the SAME Entra application registration GuideHerd already uses for
 *     Graph mail (#60/#72) — one app, one admin consent, permissions
 *     granted per workload;
 *   - client-credentials flow (application permissions), scope
 *     https://graph.microsoft.com/.default, exactly like the proven
 *     mail path (notifications/graph-email-provider.js);
 *   - least privilege: Calendars.ReadWrite APPLICATION permission,
 *     scoped to the firm's schedulable mailboxes with an Exchange
 *     application access policy — the restrictive default. The
 *     permission matrix and the policy walkthrough live in the doc.
 *
 * Credentials arrive by ENVIRONMENT REFERENCE only (MS_TENANT_ID /
 * MS_CLIENT_ID / MS_CLIENT_SECRET — names, never values, in
 * configuration, code, logs, or errors). Missing credentials or revoked
 * consent FAIL CLOSED as configuration
 * (CalendarProviderNotConfiguredError -> 503 family) with distinct
 * telemetry; transient token trouble is CalendarUnavailableError. Every
 * thrown error carries `phase: 'token'` so write-path callers (#86) can
 * classify it as definitively-not-attempted rather than ambiguous.
 *
 * Tokens are cached until shortly before expiry and acquisition is
 * SINGLE-FLIGHT — concurrent calendar reads never stampede the identity
 * provider.
 *
 * ASSUMPTIONS REQUIRING LIVE CONFIRMATION (#95, pending the Microsoft
 * support case): that the granted application permissions actually
 * authorize target-mailbox calendar operations under the access policy;
 * real AADSTS failure shapes for revoked consent. Nothing here claims
 * production readiness until #95 passes.
 */

const {
  CalendarProviderNotConfiguredError,
  CalendarUnavailableError,
} = require('./calendar-provider');

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
/** Refresh this long before the provider-declared expiry. */
const EXPIRY_SKEW_MS = 120_000;

const tagPhase = (err) => {
  err.phase = 'token';
  return err;
};

/**
 * Presence-only connection state for readiness (#77), the
 * Administration Portal (#91), and the Operations Center (#92).
 * Booleans and names ONLY — never a value.
 */
function graphCalendarConnectionState({ env = process.env } = {}) {
  const present = (name) => Boolean(env[name] && String(env[name]).trim() !== '');
  const state = {
    tenantIdPresent: present('MS_TENANT_ID'),
    clientIdPresent: present('MS_CLIENT_ID'),
    clientSecretPresent: present('MS_CLIENT_SECRET'),
  };
  return {
    ...state,
    configured: state.tenantIdPresent && state.clientIdPresent && state.clientSecretPresent,
    missing: ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'].filter((name) => !present(name)),
  };
}

/**
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *           telemetry?: { event: Function }, clock?: { now(): number },
 *           requestTimeoutMs?: number }} [deps]
 * @returns {{ configured: boolean, getToken(): Promise<string>, invalidate(): void }}
 */
function createGraphCalendarAuth({
  env = process.env, fetchImpl = fetch, telemetry = null,
  clock = { now: () => Date.now() }, requestTimeoutMs = 10_000,
} = {}) {
  const config = {
    tenantId: env.MS_TENANT_ID,
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
  };
  const configured = Boolean(config.tenantId && config.clientId && config.clientSecret);
  const emit = (name, fields) => {
    if (telemetry) {
      telemetry.event(name, {
        component: 'calendar-provider', operation: 'graph-token',
        provider: 'microsoft-graph', ...fields,
      });
    }
  };

  let cached = null; // { token, expiresAtMs }
  let inFlight = null;

  async function fetchToken() {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    });
    let res;
    try {
      res = await fetchImpl(TOKEN_URL(config.tenantId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw tagPhase(new CalendarUnavailableError(timeout ? 'token_timeout' : 'token_network_failure'));
    }
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        throw tagPhase(new CalendarUnavailableError(`token_http_${res.status}`));
      }
      // 400/401/403: bad credentials, deleted app, or REVOKED CONSENT —
      // configuration, not weather. Fail closed, loudly, without ever
      // echoing what was sent.
      emit('provider.authentication_failed', {
        severity: 'error', category: 'provider_authentication_failed',
        retryable: false, httpStatus: res.status,
      });
      throw tagPhase(new CalendarProviderNotConfiguredError());
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw tagPhase(new CalendarUnavailableError('token_malformed_response'));
    }
    if (!json || typeof json.access_token !== 'string') {
      throw tagPhase(new CalendarUnavailableError('token_malformed_response'));
    }
    const lifetimeMs = Number.isFinite(Number(json.expires_in))
      ? Number(json.expires_in) * 1000
      : 300_000;
    cached = {
      token: json.access_token,
      expiresAtMs: clock.now() + Math.max(lifetimeMs - EXPIRY_SKEW_MS, 30_000),
    };
    return cached.token;
  }

  return {
    configured,

    /** The current bearer token — cached, refreshed with skew, single-flight. */
    async getToken() {
      if (!configured) throw tagPhase(new CalendarProviderNotConfiguredError());
      if (cached && cached.expiresAtMs > clock.now()) return cached.token;
      if (!inFlight) {
        inFlight = fetchToken().finally(() => { inFlight = null; });
      }
      return inFlight;
    },

    /** Drop the cache (a 401 mid-operation forces one fresh acquisition). */
    invalidate() {
      cached = null;
    },
  };
}

module.exports = {
  createGraphCalendarAuth,
  graphCalendarConnectionState,
  GRAPH_SCOPE,
  EXPIRY_SKEW_MS,
};
