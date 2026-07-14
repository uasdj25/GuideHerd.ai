'use strict';

/**
 * GuideHerd Consultation Summary.
 *
 * The summary is a GuideHerd domain artifact first and an email body second:
 * `buildConsultationSummary` produces the structured model from trusted stored
 * session context plus the validated outcome; `renderSummaryHtml` renders it.
 * Keeping construction separate from rendering lets the same model later be
 * rendered as PDF, shown in GuideHerd Console, stored in the Operational
 * Store, or sent to another business system.
 *
 * The summary never contains: tokens or credential metadata, provider-specific
 * identifiers, raw conversation transcripts, invented information, or legal
 * analysis/advice of any kind.
 *
 * Note for the future: once multiple AI Employees exist, summaries may carry
 * provenance (which AI Employee, human, or mixed handling produced each part).
 * No implementation now — model shape only when the need arrives.
 */

const OUTCOME_HEADLINES = {
  booked: 'Appointment booked',
  failed: 'Scheduling could not be completed',
  escalated: 'Human assistance required',
};

/** Format epoch milliseconds as an ISO-8601 UTC string, or null. */
function toIso(ms) {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

/**
 * Build the structured Consultation Summary model from a completed session.
 * Uses only trusted stored context and the validated outcome — nothing is
 * inferred or invented.
 * @param {import('./models').InternalSession} session
 */
function buildConsultationSummary(session) {
  const outcome = session.outcome || {};
  const appointment = outcome.appointment || null;

  return {
    caller: {
      fullName: session.caller.fullName,
      email: session.caller.email,
      phone: session.caller.phone ?? null,
      existingClient: session.scheduling.existingClient ?? false,
    },
    request: {
      attorneyId: session.scheduling.attorneyId,
      practiceAreaId: session.scheduling.practiceAreaId ?? null,
      consultationTypeId: session.scheduling.consultationTypeId,
    },
    outcome: {
      status: session.status,
      appointmentStartsAt: appointment ? appointment.startsAt : null,
      timezone: appointment ? appointment.timezone : null,
    },
    notes: {
      schedulingSummary: outcome.schedulingSummary ?? '',
      unresolvedQuestions: outcome.unresolvedQuestions ?? [],
      escalationRequired: outcome.escalationRequired ?? (session.status === 'escalated'),
    },
    timestamps: {
      createdAt: toIso(session.createdAtMs),
      connectedAt: toIso(session.redeemedAtMs),
      completedAt: toIso(session.completedAtMs),
    },
  };
}

/** Escape user-controlled content for HTML rendering. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format an ISO timestamp for humans in the given IANA timezone. */
function formatWhen(iso, timezone) {
  if (!iso) return null;
  try {
    const date = new Date(iso);
    const opts = { dateStyle: 'full', timeStyle: 'short' };
    if (timezone) opts.timeZone = timezone;
    return new Intl.DateTimeFormat('en-US', opts).format(date)
      + (timezone ? ` (${timezone})` : '');
  } catch {
    return iso; // unknown timezone string — show the raw ISO rather than guess
  }
}

/** Format just the date portion for subject lines. */
function formatDateOnly(iso, timezone) {
  if (!iso) return null;
  try {
    const opts = { dateStyle: 'long' };
    if (timezone) opts.timeZone = timezone;
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Deterministic email subject.
 *   booked   -> GuideHerd Consultation Summary — {Caller} — {Appointment Date}
 *   others   -> GuideHerd Consultation Summary — {Caller} — {Outcome headline}
 */
function summarySubject(model) {
  const name = model.caller.fullName;
  if (model.outcome.status === 'booked' && model.outcome.appointmentStartsAt) {
    return `GuideHerd Consultation Summary — ${name} — ${formatDateOnly(model.outcome.appointmentStartsAt, model.outcome.timezone)}`;
  }
  const headline = OUTCOME_HEADLINES[model.outcome.status] || 'Scheduling update';
  return `GuideHerd Consultation Summary — ${name} — ${headline}`;
}

/** Render one label/value row; value is escaped. Returns '' for null values. */
function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr>
    <td style="padding:6px 16px 6px 0; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:#6b7a86; vertical-align:top; white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0; font-size:14px; color:#0E2A3F; font-weight:500;">${escapeHtml(value)}</td>
  </tr>`;
}

/**
 * Render the GuideHerd-branded, accessible HTML document for a summary model.
 * All user-controlled content is escaped. Inline styles only (email-safe).
 * @param {ReturnType<typeof buildConsultationSummary>} model
 */
function renderSummaryHtml(model) {
  const headline = OUTCOME_HEADLINES[model.outcome.status] || 'Scheduling update';
  const when = formatWhen(model.outcome.appointmentStartsAt, model.outcome.timezone);

  const questions = (model.notes.unresolvedQuestions || [])
    .map((q) => `<li style="font-size:14px; color:#1C3A52; padding:2px 0;">${escapeHtml(q)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(summarySubject(model))}</title></head>
<body style="margin:0; padding:0; background:#F5F2EA; font-family: 'Inter Tight', 'Inter', -apple-system, Segoe UI, sans-serif;">
  <div style="max-width:560px; margin:0 auto; padding:32px 24px;">
    <p style="font-family: Georgia, 'Times New Roman', serif; font-size:20px; color:#0E2A3F; margin:0 0 4px;">GuideHerd<sup style="font-size:9px; color:#2FA4A0; letter-spacing:0.08em;">AI</sup></p>
    <p style="font-size:11px; letter-spacing:0.16em; text-transform:uppercase; color:#6b7a86; margin:0 0 24px;">Consultation Summary</p>

    <div style="background:#FBF8F1; border:1px solid rgba(14,42,63,0.10); border-radius:12px; padding:24px;">
      <p style="font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:#0E6D6A; margin:0 0 4px;">Outcome</p>
      <h1 style="font-family: Georgia, serif; font-weight:normal; font-size:24px; color:#0E2A3F; margin:0 0 8px;">${escapeHtml(headline)}</h1>
      ${when ? `<p style="font-size:16px; color:#0E6D6A; font-weight:600; margin:0 0 16px;">${escapeHtml(when)}</p>` : ''}

      <table role="presentation" style="border-collapse:collapse; width:100%; border-top:1px solid rgba(14,42,63,0.10); margin-top:8px; padding-top:8px;">
        ${row('Caller', model.caller.fullName)}
        ${row('Email', model.caller.email)}
        ${row('Phone', model.caller.phone)}
        ${row('Client status', model.caller.existingClient ? 'Existing client' : 'Prospective client')}
        ${row('Attorney', model.request.attorneyId)}
        ${row('Practice area', model.request.practiceAreaId)}
        ${row('Consultation type', model.request.consultationTypeId)}
      </table>

      ${model.notes.schedulingSummary ? `
      <p style="font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:#6b7a86; margin:16px 0 4px;">Scheduling notes</p>
      <p style="font-size:14px; color:#1C3A52; margin:0;">${escapeHtml(model.notes.schedulingSummary)}</p>` : ''}

      ${questions ? `
      <p style="font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:#6b7a86; margin:16px 0 4px;">Open questions</p>
      <ul style="margin:0; padding-left:18px;">${questions}</ul>` : ''}

      ${model.notes.escalationRequired ? `
      <p style="font-size:14px; color:#A63B2A; font-weight:600; margin:16px 0 0;">This caller needs follow-up from your team.</p>` : ''}
    </div>

    <p style="font-size:11px; color:#8a94a0; margin:20px 0 0; line-height:1.7;">
      Scheduling only. No legal advice was provided.<br>
      <span style="letter-spacing:0.1em; text-transform:uppercase;">Powered by GuideHerd</span>
    </p>
  </div>
</body>
</html>`;
}

module.exports = { buildConsultationSummary, renderSummaryHtml, summarySubject };
