'use strict';

/**
 * Operational-alert rendering (GitLab #68) — the administrator-facing
 * email for a raised failure condition. Content discipline mirrors the
 * Operations Center: condition names, counts, capability names, and
 * session identifiers only — structurally no caller PII (the model is
 * built by the alerting service from bounded scalars, and everything is
 * HTML-escaped here regardless).
 */

const { registerNotificationRenderer } = require('./templates');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const CONDITION_TEXT = {
  'booking-verification-required': 'A booking outcome could not be confirmed with the calendar provider. The caller was told neither booked nor failed — an operator must resolve it from the Operations Center before anyone contacts the caller.',
  'handoff-outcomes-failing':
    'Multiple caller handoffs have failed in a short window. Each one is a caller who did not get booked.',
  'notification-delivery-failed':
    'A notification exhausted its delivery retries. Nobody was told — check the delivery records.',
};

function describeCondition(condition) {
  if (CONDITION_TEXT[condition]) return CONDITION_TEXT[condition];
  if (condition.startsWith('capability-degraded:')) {
    return `A platform capability (${condition.split(':')[1]}) has degraded. Related features may be failing or dark.`;
  }
  return 'An operational failure condition was raised.';
}

registerNotificationRenderer('operational-alert', (request) => {
  const m = request.model || {};
  const condition = esc(m.condition);
  const lines = [
    ['Condition', condition],
    ['What it means', esc(describeCondition(m.condition || ''))],
    m.count !== undefined && m.count !== null ? ['Occurrences', esc(m.count)] : null,
    m.windowMinutes ? ['Window', `${esc(m.windowMinutes)} minutes`] : null,
    m.capability ? ['Capability', esc(m.capability)] : null,
    m.status ? ['Status', esc(m.status)] : null,
    m.notificationType ? ['Notification type', esc(m.notificationType)] : null,
    m.sessionId ? ['Example session', esc(m.sessionId)] : null,
  ].filter(Boolean);

  const text = [
    `GuideHerd operational alert: ${m.condition}`,
    ...lines.map(([k, v]) => `${k}: ${v}`),
    'Investigate in the Operations Center. This alert is sent at most once per condition per window.',
  ].join('\n');

  return {
    subject: `GuideHerd alert: ${m.condition}`,
    html: `<h2 style="margin:0 0 12px">GuideHerd operational alert</h2>
<table cellpadding="4" style="border-collapse:collapse">${lines.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join('')}</table>
<p>Investigate in the Operations Center. This alert is sent at most once per condition per window.</p>`,
    text,
  };
});

module.exports = { describeCondition };
