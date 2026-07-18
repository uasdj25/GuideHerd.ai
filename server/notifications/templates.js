'use strict';

/**
 * Provider-independent notification templates (ADR-0011).
 *
 * Core supplies canonical GuideHerd data (a validated NotificationRequest
 * plus the organization's branding); this module renders the message a
 * customer reads — subject, HTML, and plain text. Providers deliver what
 * is rendered here and never compose content themselves; no HTML lives in
 * business logic, and no provider or implementation names appear in any
 * rendered output.
 *
 * Localization-ready: every human-readable string lives in the STRINGS
 * catalog keyed by locale. en-US is the only catalog today; adding a
 * locale adds an entry, not code.
 */

const STRINGS = Object.freeze({
  'en-US': Object.freeze({
    'appointment-confirmation': {
      subject: (m) => `Your consultation with ${m.senderName} is confirmed`,
      heading: () => 'Your appointment is confirmed',
      lead: (m) => `Thank you${m.recipientFirstName ? `, ${m.recipientFirstName}` : ''}. Your consultation with ${m.senderName} has been scheduled.`,
    },
    'appointment-cancellation': {
      subject: (m) => `Your appointment with ${m.senderName} has been cancelled`,
      heading: () => 'Your appointment is cancelled',
      lead: (m) => `Your consultation with ${m.senderName} has been cancelled. If this is unexpected, please contact the office.`,
    },
    'appointment-rescheduled': {
      subject: (m) => `Your appointment with ${m.senderName} has been rescheduled`,
      heading: () => 'Your appointment has been rescheduled',
      lead: (m) => `Your consultation with ${m.senderName} has been moved to a new time.`,
    },
    'appointment-reminder': {
      subject: (m) => `Reminder: your consultation with ${m.senderName}`,
      heading: () => 'Appointment reminder',
      lead: (m) => `This is a friendly reminder of your upcoming consultation with ${m.senderName}.`,
    },
    labels: {
      when: 'When',
      attorney: 'Attorney',
      consultationType: 'Consultation',
      location: 'Location',
      office: 'Office',
    },
  }),
});

/** HTML-escape untrusted text values before they enter markup. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Human-readable appointment time in the appointment's own timezone. */
function formatWhen(startsAt, timezone, locale) {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(startsAt)) + ` (${timezone})`;
  } catch {
    return `${startsAt} (${timezone})`;
  }
}

/**
 * Build the canonical, provider-independent template model.
 * @param {ReturnType<typeof import('./contract').validateNotificationRequest>} request
 * @param {ReturnType<typeof import('./branding').resolveBranding>} branding
 */
function buildTemplateModel(request, branding) {
  const locale = STRINGS[request.locale] ? request.locale : 'en-US';
  return {
    type: request.type,
    locale,
    senderName: branding.senderName,
    accentColor: branding.accentColor,
    logoUrl: branding.logoUrl,
    footerText: branding.footerText,
    office: branding.office,
    recipientName: request.recipient.name,
    recipientFirstName: request.recipient.name ? request.recipient.name.trim().split(/\s+/)[0] : null,
    when: formatWhen(request.appointment.startsAt, request.appointment.timezone, locale),
    attorneyName: request.appointment.attorneyName,
    consultationType: request.appointment.consultationType,
    location: request.appointment.location,
  };
}

/**
 * Render a notification for delivery: subject, HTML, and plain text.
 * @param {ReturnType<typeof buildTemplateModel>} model
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderNotification(model) {
  const strings = STRINGS[model.locale] || STRINGS['en-US'];
  const copy = strings[model.type];
  const labels = strings.labels;

  const subject = copy.subject(model);
  const heading = copy.heading(model);
  const lead = copy.lead(model);

  const details = [
    [labels.when, model.when],
    [labels.attorney, model.attorneyName],
    [labels.consultationType, model.consultationType],
    [labels.location, model.location],
  ].filter(([, value]) => value);

  const officeLines = [model.office.phone, model.office.email, model.office.address].filter(Boolean);

  const text = [
    heading,
    '',
    lead,
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    ...(officeLines.length ? ['', `${labels.office}:`, ...officeLines] : []),
    '',
    model.footerText,
  ].join('\n');

  const e = escapeHtml;
  const html = [
    `<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #222;">`,
    model.logoUrl ? `<img src="${e(model.logoUrl)}" alt="${e(model.senderName)}" style="max-height: 48px; margin: 24px 0 8px;">` : '',
    `<h1 style="font-size: 20px; border-bottom: 3px solid ${e(model.accentColor)}; padding-bottom: 8px;">${e(heading)}</h1>`,
    `<p>${e(lead)}</p>`,
    details.length
      ? `<table style="border-collapse: collapse; margin: 16px 0;">${details
          .map(([label, value]) => `<tr><td style="padding: 4px 12px 4px 0; color: #555;">${e(label)}</td><td style="padding: 4px 0;"><strong>${e(value)}</strong></td></tr>`)
          .join('')}</table>`
      : '',
    officeLines.length
      ? `<p style="color: #555;">${e(labels.office)}:<br>${officeLines.map((l) => e(l)).join('<br>')}</p>`
      : '',
    `<p style="color: #888; font-size: 12px; border-top: 1px solid #ddd; padding-top: 12px; margin-top: 24px;">${e(model.footerText)}</p>`,
    `</div>`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

module.exports = { buildTemplateModel, renderNotification, STRINGS };
