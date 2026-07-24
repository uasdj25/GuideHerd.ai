'use strict';

/**
 * Native slot generation (GitLab #78) — GuideHerd computes bookable
 * appointment slots itself: business-hours windows minus provider busy
 * intervals, shaped by the tenant's booking-window policy (buffers,
 * minimum notice, booking horizon, granularity, holiday exceptions).
 *
 * The three-hours model the customer documentation teaches is honored:
 * appointment-booking availability comes from the firm's configured
 * OFFICE HOURS (the same location officeHours the deployed
 * business-hours constraint enforces, hours.js) or an explicit
 * per-attorney override — never from a provider, never assumed.
 *
 * FAIL CLOSED, always:
 *   - no resolvable hours -> NO slots (absence of policy is never 24/7
 *     bookability);
 *   - several hours-bearing locations and no way to attribute ->
 *     'ambiguous_hours', no slots (nothing guesses which office);
 *   - busy data must be SUPPLIED — the caller (#79) fails closed on any
 *     provider read failure long before generation runs.
 *
 * DETERMINISTIC: identical inputs produce identical slot lists; slots
 * are aligned to the granularity grid anchored at each window's opening
 * and emitted chronologically.
 *
 * TIMEZONE-CORRECT: windows are local wall-clock rules ("09:00" in the
 * firm's IANA timezone); instants are derived per local calendar day via
 * iterative offset resolution, so DST transitions shift generated slots
 * with the wall clock (a 09:00 slot is 15:00 UTC in winter and 14:00 UTC
 * in summer for America/Chicago) and never duplicate or skip a day.
 *
 * Ranking is NOT here: the ADR-0012 policy engine remains the ranking
 * authority (#79 feeds generated slots through it).
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Wall-clock parts of a UTC instant in a timezone (cached formatter). */
const partFormatters = new Map();
function wallClockParts(utcMs, timeZone) {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', weekday: 'short',
    });
    partFormatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(utcMs))) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function timezoneOffsetMs(timeZone, utcMs) {
  const p = wallClockParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time (iterative offset
 * resolution; converges in two steps for every real timezone). During a
 * spring-forward gap the nonexistent local time resolves to the shifted
 * instant — a window opening inside the gap starts when the clock
 * actually reaches it.
 */
function zonedTimeToUtcMs({ year, month, day, minutesOfDay }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const once = guess - timezoneOffsetMs(timeZone, guess);
  const twice = guess - timezoneOffsetMs(timeZone, once);
  return twice;
}

/** Local calendar date (y/m/d + weekday) of an instant, in a timezone. */
function localDateOf(utcMs, timeZone) {
  const p = wallClockParts(utcMs, timeZone);
  return { year: p.year, month: p.month, day: p.day, dayOfWeek: p.dayOfWeek };
}

const toMinutesOfDay = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
const dateKey = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * Resolve the weekly hours windows a scheduling target generates from.
 * Attorney override first (explicit policy); otherwise the organization's
 * SINGLE hours-bearing location; several without attribution is
 * ambiguous — fail closed, loudly.
 *
 * @returns {{ windows: Array<{dayOfWeek:number, opens:string, closes:string}>,
 *             timezone: string|null,
 *             source: 'attorney-override'|'location'|null,
 *             reason: 'no_hours'|'ambiguous_hours'|null }}
 */
function resolveHoursForTarget({ attorneyId = null, attorneyHours = {}, locations = [], orgTimezone }) {
  if (attorneyId && Array.isArray(attorneyHours[attorneyId]) && attorneyHours[attorneyId].length > 0) {
    return {
      windows: attorneyHours[attorneyId], timezone: orgTimezone,
      source: 'attorney-override', reason: null,
    };
  }
  const withHours = (locations || []).filter((l) => Array.isArray(l.officeHours) && l.officeHours.length > 0);
  if (withHours.length === 1) {
    return {
      windows: withHours[0].officeHours,
      timezone: withHours[0].timezone || orgTimezone,
      source: 'location', reason: null,
    };
  }
  return {
    windows: [], timezone: null, source: null,
    reason: withHours.length === 0 ? 'no_hours' : 'ambiguous_hours',
  };
}

/**
 * Generate candidate slots. Pure and deterministic; all time arrives as
 * arguments (clock-injected per the repository's test conventions).
 *
 * A slot { startsAt } qualifies iff:
 *   - [start, start+duration] fits inside ONE hours window on ONE local
 *     calendar day (appointments never straddle midnight or windows);
 *   - the local day is not an exception closure;
 *   - start >= nowMs + minimumNoticeMinutes;
 *   - start + duration <= nowMs + horizonDays;
 *   - [start - bufferBefore, start + duration + bufferAfter] overlaps no
 *     busy interval (buffers guard travel/prep time BETWEEN engagements;
 *     they do not shrink the firm's own hours);
 *   - start lies on the granularity grid anchored at the window opening.
 *
 * @param {{
 *   windows: Array<{dayOfWeek:number, opens:string, closes:string}>,
 *   timezone: string,
 *   busyIntervals: Array<{startsAt:string, endsAt:string}>,  REQUIRED —
 *     the caller fails closed before calling when busy data is unavailable
 *   durationMinutes: number,
 *   windowStartMs: number, windowEndMs: number,   the requested range
 *   nowMs: number,
 *   policy: { bufferBeforeMinutes?: number, bufferAfterMinutes?: number,
 *             minimumNoticeMinutes?: number, horizonDays?: number,
 *             slotGranularityMinutes?: number,
 *             exceptions?: Array<{date:string}> },
 * }} args
 * @returns {Array<{ startsAt: string }>}
 */
function generateCandidateSlots({
  windows, timezone, busyIntervals, durationMinutes, windowStartMs, windowEndMs, nowMs, policy = {},
}) {
  if (!Array.isArray(busyIntervals)) {
    throw new TypeError('generateCandidateSlots requires busyIntervals — the caller fails closed without them');
  }
  if (!Array.isArray(windows) || windows.length === 0 || !timezone) return [];
  const {
    bufferBeforeMinutes = 0,
    bufferAfterMinutes = 0,
    minimumNoticeMinutes = 0,
    horizonDays = 60,
    slotGranularityMinutes = 30,
    exceptions = [],
  } = policy;
  const closedDates = new Set(exceptions.map((e) => e.date));
  const durationMs = durationMinutes * MS_PER_MINUTE;
  const earliestStartMs = Math.max(windowStartMs, nowMs + minimumNoticeMinutes * MS_PER_MINUTE);
  const horizonEndMs = nowMs + horizonDays * MS_PER_DAY;
  const latestEndMs = Math.min(windowEndMs, horizonEndMs);
  if (earliestStartMs >= latestEndMs) return [];

  const busy = busyIntervals
    .map((b) => ({ startMs: Date.parse(b.startsAt), endMs: Date.parse(b.endsAt) }))
    .filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs));
  const guardedOverlapsBusy = (startMs) => {
    const guardStart = startMs - bufferBeforeMinutes * MS_PER_MINUTE;
    const guardEnd = startMs + durationMs + bufferAfterMinutes * MS_PER_MINUTE;
    return busy.some((b) => b.startMs < guardEnd && b.endMs > guardStart);
  };

  const slots = [];
  // Iterate local calendar days across the range. Anchoring the step at
  // local noon dodges DST arithmetic ever skipping or repeating a day.
  let cursor = zonedTimeToUtcMs({ ...localDateOf(windowStartMs, timezone), minutesOfDay: 12 * 60 }, timezone);
  const stopMs = latestEndMs + MS_PER_DAY;
  while (cursor <= stopMs) {
    const day = localDateOf(cursor, timezone);
    if (!closedDates.has(dateKey(day))) {
      for (const window of windows) {
        if (window.dayOfWeek !== day.dayOfWeek) continue;
        const opensMs = zonedTimeToUtcMs({ ...day, minutesOfDay: toMinutesOfDay(window.opens) }, timezone);
        const closesMs = zonedTimeToUtcMs({ ...day, minutesOfDay: toMinutesOfDay(window.closes) }, timezone);
        for (let startMs = opensMs; startMs + durationMs <= closesMs; startMs += slotGranularityMinutes * MS_PER_MINUTE) {
          if (startMs < earliestStartMs) continue;
          if (startMs + durationMs > latestEndMs) break;
          if (guardedOverlapsBusy(startMs)) continue;
          slots.push({ startsAt: new Date(startMs).toISOString() });
        }
      }
    }
    cursor += MS_PER_DAY;
  }
  slots.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return slots;
}

/**
 * Normalize the `scheduling/booking-window` settings document — the
 * tenant's booking-shape policy. LENIENT reads with safe defaults;
 * strict issues for the producer. Hours themselves stay where they live
 * today (location officeHours / attorneyHours overrides) — absent hours
 * mean NO availability, so no default here can open a calendar.
 */
function normalizeBookingWindowConfig(raw) {
  const defaults = {
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    horizonDays: 60,
    slotGranularityMinutes: 30,
    cancellationCutoffMinutes: 0,
    exceptions: [],
    attorneyHours: {},
  };
  if (raw === null || raw === undefined) return { value: defaults, issues: [] };
  if (!isPlainObject(raw)) {
    return { value: defaults, issues: ['must be an object like { "minimumNoticeMinutes": 1440, "horizonDays": 60 }'] };
  }
  const issues = [];
  for (const k of Object.keys(raw)) {
    if (!Object.keys(defaults).includes(k)) issues.push(`unknown field: ${k}`);
  }
  const value = { ...defaults };
  const intField = (name, min, max) => {
    if (raw[name] === undefined) return;
    if (Number.isInteger(raw[name]) && raw[name] >= min && raw[name] <= max) value[name] = raw[name];
    else issues.push(`${name} must be an integer between ${min} and ${max}`);
  };
  intField('bufferBeforeMinutes', 0, 240);
  intField('bufferAfterMinutes', 0, 240);
  intField('minimumNoticeMinutes', 0, 40320); // up to 4 weeks
  intField('horizonDays', 1, 365);
  intField('slotGranularityMinutes', 5, 240);
  intField('cancellationCutoffMinutes', 0, 40320);
  if (raw.exceptions !== undefined) {
    if (!Array.isArray(raw.exceptions)) {
      issues.push('exceptions must be an array of { "date": "YYYY-MM-DD" }');
    } else {
      const dates = [];
      for (const entry of raw.exceptions) {
        const date = isPlainObject(entry) && typeof entry.date === 'string' ? entry.date.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          issues.push('every exception needs a date formatted YYYY-MM-DD');
        } else if (!dates.some((d) => d.date === date)) {
          dates.push({ date });
        }
      }
      value.exceptions = dates;
    }
  }
  if (raw.attorneyHours !== undefined) {
    if (!isPlainObject(raw.attorneyHours)) {
      issues.push('attorneyHours must map attorney keys to weekly hours arrays');
    } else {
      const hours = {};
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
      for (const [key, entries] of Object.entries(raw.attorneyHours)) {
        if (typeof key !== 'string' || key.trim() === '' || !Array.isArray(entries)) {
          issues.push('attorneyHours entries must be { "<attorneyKey>": [ { dayOfWeek, opens, closes } ] }');
          continue;
        }
        const cleaned = [];
        for (const w of entries) {
          if (!isPlainObject(w) || !Number.isInteger(w.dayOfWeek) || w.dayOfWeek < 0 || w.dayOfWeek > 6
            || !HHMM.test(String(w.opens)) || !HHMM.test(String(w.closes))
            || toMinutesOfDay(w.opens) >= toMinutesOfDay(w.closes)) {
            issues.push(`attorneyHours.${key}: every window needs dayOfWeek 0-6 and opens < closes as HH:MM`);
            continue;
          }
          cleaned.push({ dayOfWeek: w.dayOfWeek, opens: w.opens, closes: w.closes });
        }
        if (cleaned.length > 0) hours[key.trim()] = cleaned;
      }
      value.attorneyHours = hours;
    }
  }
  return { value, issues };
}

/** STRICT cross-entity rules: attorney-hour overrides name real, active attorneys. */
function validateBookingWindowCrossEntity(value, context) {
  const { configService, organizationKey } = context || {};
  if (!configService || !organizationKey) return [];
  const issues = [];
  for (const key of Object.keys(value.attorneyHours)) {
    let attorney = null;
    try { attorney = configService.providers.get(organizationKey, key); } catch { attorney = null; }
    if (!attorney) issues.push(`attorneyHours.${key}: unknown attorney`);
    else if (attorney.active === false) issues.push(`attorneyHours.${key}: attorney is not active`);
  }
  return issues;
}

module.exports = {
  generateCandidateSlots,
  resolveHoursForTarget,
  normalizeBookingWindowConfig,
  validateBookingWindowCrossEntity,
  zonedTimeToUtcMs,
  localDateOf,
};
