'use strict';

/**
 * ICS (RFC 5545) calendar attachments for appointment notifications
 * (GitLab #88) — so the caller's OWN calendar reflects the appointment
 * lifecycle regardless of provider: confirmation carries METHOD:REQUEST,
 * a reschedule carries a bumped SEQUENCE, and a cancellation carries
 * METHOD:CANCEL with STATUS:CANCELLED. The UID is the notification's
 * booking identity (stable across the lifecycle) — never caller data.
 */

const escapeText = (value) => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

const icsUtc = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * @param {{ uid: string, startsAt: string, durationMinutes?: number,
 *           summary: string, description?: string,
 *           method?: 'REQUEST'|'CANCEL', sequence?: number, nowMs?: number }} args
 * @returns {{ filename: string, contentType: string, content: string }}
 */
function buildAppointmentIcs({
  uid, startsAt, durationMinutes = 30, summary, description,
  method = 'REQUEST', sequence = 0, nowMs = 0,
}) {
  const startMs = Date.parse(startsAt);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GuideHerd//Scheduling//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}`,
    `DTSTAMP:${icsUtc(nowMs)}`,
    `DTSTART:${icsUtc(startMs)}`,
    `DTEND:${icsUtc(startMs + durationMinutes * 60_000)}`,
    `SEQUENCE:${sequence}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return {
    filename: method === 'CANCEL' ? 'cancellation.ics' : 'appointment.ics',
    contentType: `text/calendar; method=${method}`,
    content: `${lines.join('\r\n')}\r\n`,
  };
}

module.exports = { buildAppointmentIcs };
