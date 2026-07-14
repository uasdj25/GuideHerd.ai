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
 * Never logged: credentials, tokens, message bodies, recipient content.
 */

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
const SEND_URL = (mailbox) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetchImpl?: typeof fetch,   // injected in tests; never call real Graph there
 * }} [deps]
 */
function createMailer({ env = process.env, fetchImpl = fetch } = {}) {
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

  async function acquireToken() {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await fetchImpl(TOKEN_URL(config.tenantId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('token acquisition failed'); // no detail: may echo config
    const json = await res.json();
    if (!json || typeof json.access_token !== 'string') throw new Error('token response malformed');
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
     */
    async sendSummary({ subject, html }) {
      if (!enabled) return { status: 'not-configured' };
      try {
        const token = await acquireToken();
        const res = await fetchImpl(SEND_URL(config.mailbox), {
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
        // Graph confirms acceptance with 202. Anything else is a failure.
        if (res.status === 202) return { status: 'sent' };
        return { status: 'failed' };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}

module.exports = { createMailer };
