'use strict';

/**
 * Business-hours constraint (ADR-0012 / GitLab #66) — the consumer that
 * makes configured office hours REAL.
 *
 * Honors the three-hours model the customer documentation teaches:
 * Guide availability ≠ staffed reception hours ≠ appointment-booking
 * availability. A Guide answering 24/7 must still offer only slots the
 * firm's booking rules allow — so this is a HARD constraint, unlike
 * policy preferences (which rank) and preference filters (which relax):
 * a slot outside configured hours is never offered. If the constraint
 * removes everything, the honest answer is an empty offer plus a loud
 * telemetry event — the firm's own rules excluded what the calendar had.
 *
 * Scoping rules, deterministic and documented:
 *  - The constraint is inert unless at least one location has hours.
 *  - A slot naming a configured location's key is judged by THAT
 *    location's hours (in that location's timezone, falling back to the
 *    organization's).
 *  - A slot with no recognizable location is judged by the organization's
 *    single hours-bearing location when exactly one exists; with several,
 *    the slot cannot be attributed and passes unconstrained (counted as
 *    `unscoped` — visible, never silent).
 *  - The WHOLE appointment (start through start+duration) must fit inside
 *    one window on one local day; appointments crossing midnight or a
 *    window boundary are excluded. Days without a window are closed.
 */

/** Local weekday index (0=Sunday..6, matching config officeHours) and minutes. */
function localDayMinutes(iso, timezone) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: timezone,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    if (dayOfWeek === -1) return null;
    return { dayOfWeek, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  } catch {
    return null; // unknown timezone: caller treats as unjudgeable
  }
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/** Does [startsAt, startsAt+durationMinutes] fit inside one window? */
function fitsBusinessHours(slot, officeHours, timezone) {
  const start = localDayMinutes(slot.startsAt, timezone);
  const endInstant = new Date(Date.parse(slot.startsAt) + (slot.durationMinutes || 0) * 60_000).toISOString();
  const end = localDayMinutes(endInstant, timezone);
  if (!start || !end) return false; // unjudgeable time excludes, fail closed
  if (start.dayOfWeek !== end.dayOfWeek) return false; // crosses midnight
  return officeHours.some((w) => w.dayOfWeek === start.dayOfWeek
    && toMinutes(w.opens) <= start.minutes
    && end.minutes <= toMinutes(w.closes));
}

/**
 * @param {{ slots: object[], locations: object[], orgTimezone: string }} args
 *        locations: configService.locations.list() shape (key, timezone,
 *        officeHours[{dayOfWeek, opens, closes}]).
 * @returns {{ slots: object[], status: 'none'|'applied',
 *             removed: number, unscoped: number }}
 */
function applyBusinessHoursConstraint({ slots, locations, orgTimezone }) {
  const withHours = (locations || []).filter((l) => Array.isArray(l.officeHours) && l.officeHours.length > 0);
  if (withHours.length === 0) return { slots, status: 'none', removed: 0, unscoped: 0 };

  const byKey = new Map(withHours.map((l) => [l.key, l]));
  const soleLocation = withHours.length === 1 ? withHours[0] : null;
  const kept = [];
  let removed = 0;
  let unscoped = 0;

  for (const slot of slots) {
    const location = (slot.location && byKey.get(slot.location)) || soleLocation;
    if (!location) {
      unscoped += 1;
      kept.push(slot);
      continue;
    }
    if (fitsBusinessHours(slot, location.officeHours, location.timezone || orgTimezone)) {
      kept.push(slot);
    } else {
      removed += 1;
    }
  }
  return { slots: kept, status: 'applied', removed, unscoped };
}

module.exports = { applyBusinessHoursConstraint, fitsBusinessHours, localDayMinutes };
