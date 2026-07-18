'use strict';

/**
 * The GuideHerd Scheduling Policy Engine (ADR-0012).
 *
 * Scheduling providers answer "what time is available?" — GuideHerd
 * answers "which available time should we offer?" This engine is where
 * that decision lives: it runs AFTER a scheduling provider returns
 * availability and BEFORE anything is presented to a caller. Providers
 * remain completely unaware of policy; they only supply neutral slots.
 *
 * ── The neutral slot contract ──────────────────────────────────────────────
 * A scheduling extension (ADR-0007 family; none exists in-platform yet —
 * availability is provider-side today) translates its dialect into:
 *
 *   {
 *     startsAt,             ISO-8601 datetime (parseable; required)
 *     durationMinutes?,     positive integer
 *     attorneyId?,          GuideHerd attorney key
 *     consultationTypeId?,  GuideHerd consultation type key
 *     location?             GuideHerd location key (future policies)
 *   }
 *
 * Unknown slot fields are dropped (provider payloads never ride along);
 * unparseable slots are dropped and counted, never fatal.
 *
 * ── Selection: filter, then rank — deterministically ──────────────────────
 * FILTER removes only structurally incompatible slots (a slot typed for a
 * different consultation than the caller requested), and every filter is
 * GUARDED: if it would empty the set, it relaxes instead and the result
 * says so — scheduling never fails because a preference cannot be met.
 *
 * RANK scores each slot by summing independent preference dimensions
 * (policies COMPOSE additively; they never compete):
 *
 *   +100  the caller's own requested attorney            (request)
 *   +50-i the organization's preferred attorneys, by order (policy)
 *   +30   the caller's requested consultation type        (request)
 *   +20   preferred day of week                           (policy)
 *   +20   preferred morning/afternoon                     (policy)
 *   +20   the caller's requested duration, exact          (request)
 *   +15   preferred consultation type                     (policy)
 *   +15   preferred duration, exact                       (policy)
 *
 * Ties break by earliest start, then attorney key, then original
 * position — the ordering is total, so evaluation is fully deterministic
 * for identical inputs. With NO policy and NO request preferences, every
 * score is zero and the result is chronological availability: exactly
 * today's behavior.
 *
 * Day-of-week and morning/afternoon are evaluated in the organization's
 * timezone (callers experience their firm's clock, not UTC).
 *
 * Adding a future policy dimension = one scorer in SCORERS plus its
 * policy field — the engine's control flow never changes (ADR-0007 §4).
 */

const MORNING_END_HOUR = 12; // [00:00, 12:00) is morning; the rest is afternoon

/** Sanitize provider slots into the neutral contract. */
function sanitizeSlots(slots) {
  const clean = [];
  let dropped = 0;
  for (const raw of Array.isArray(slots) ? slots : []) {
    if (raw === null || typeof raw !== 'object'
      || typeof raw.startsAt !== 'string' || Number.isNaN(Date.parse(raw.startsAt))) {
      dropped += 1;
      continue;
    }
    clean.push({
      startsAt: raw.startsAt,
      durationMinutes: Number.isInteger(raw.durationMinutes) && raw.durationMinutes > 0 ? raw.durationMinutes : null,
      attorneyId: typeof raw.attorneyId === 'string' && raw.attorneyId.trim() !== '' ? raw.attorneyId.trim() : null,
      consultationTypeId: typeof raw.consultationTypeId === 'string' && raw.consultationTypeId.trim() !== '' ? raw.consultationTypeId.trim() : null,
      location: typeof raw.location === 'string' && raw.location.trim() !== '' ? raw.location.trim() : null,
    });
  }
  return { slots: clean, dropped };
}

/** Weekday name (lowercase) and hour-of-day for a slot in a timezone. */
function localFacts(startsAt, timezone) {
  try {
    const date = new Date(startsAt);
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone })
      .format(date).toLowerCase();
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone })
      .format(date));
    return { weekday, hour };
  } catch {
    return { weekday: null, hour: null };
  }
}

/**
 * The composable scoring dimensions. Each scorer is pure:
 * (slot, facts, policy, request) -> { points, dimension } | null.
 */
const SCORERS = [
  (slot, facts, policy, request) => (request.attorneyId && slot.attorneyId === request.attorneyId
    ? { points: 100, dimension: 'requested-attorney' } : null),
  (slot, facts, policy) => {
    if (!policy || !policy.preferredAttorneys || !slot.attorneyId) return null;
    const index = policy.preferredAttorneys.indexOf(slot.attorneyId);
    return index === -1 ? null : { points: 50 - Math.min(index, 25), dimension: 'preferred-attorney' };
  },
  (slot, facts, policy, request) => (request.consultationTypeId && slot.consultationTypeId === request.consultationTypeId
    ? { points: 30, dimension: 'requested-consultation-type' } : null),
  (slot, facts, policy) => (policy && policy.preferredDaysOfWeek && facts.weekday
    && policy.preferredDaysOfWeek.includes(facts.weekday)
    ? { points: 20, dimension: 'preferred-day' } : null),
  (slot, facts, policy) => {
    if (!policy || !policy.preferredTimeOfDay || facts.hour === null) return null;
    const isMorning = facts.hour < MORNING_END_HOUR;
    const matches = policy.preferredTimeOfDay === 'morning' ? isMorning : !isMorning;
    return matches ? { points: 20, dimension: 'preferred-time-of-day' } : null;
  },
  (slot, facts, policy, request) => (request.durationMinutes && slot.durationMinutes === request.durationMinutes
    ? { points: 20, dimension: 'requested-duration' } : null),
  (slot, facts, policy) => (policy && policy.preferredConsultationTypes && slot.consultationTypeId
    && policy.preferredConsultationTypes.includes(slot.consultationTypeId)
    ? { points: 15, dimension: 'preferred-consultation-type' } : null),
  (slot, facts, policy) => (policy && policy.preferredDurationMinutes && slot.durationMinutes === policy.preferredDurationMinutes
    ? { points: 15, dimension: 'preferred-duration' } : null),
];

/** A guarded filter: never empties the candidate set. */
function guardedFilter(slots, predicate) {
  const kept = slots.filter(predicate);
  return kept.length > 0 ? { slots: kept, relaxed: false } : { slots, relaxed: true };
}

/**
 * Select which available times GuideHerd should offer.
 *
 * @param {{
 *   slots: Array<object>,          provider availability (neutral contract)
 *   policy?: object|null,          resolved organization policy
 *   request?: { attorneyId?: string, consultationTypeId?: string, durationMinutes?: number },
 *   timezone?: string,             organization timezone (day/time evaluation)
 *   limit?: number,                max candidates returned (default 10)
 * }} input
 * @returns {{
 *   candidates: Array<object & { score: number, matchedDimensions: string[] }>,
 *   applied: string[],             dimensions that influenced any candidate
 *   fallback: { requestedAttorneyUnavailable: boolean, consultationTypeRelaxed: boolean },
 *   droppedSlots: number,
 * }}
 */
function selectSlots({ slots, policy = null, request = {}, timezone = 'UTC', limit = 10 } = {}) {
  const { slots: clean, dropped } = sanitizeSlots(slots);

  // FILTER: structural incompatibility only, always guarded. A caller who
  // asked for a consultation type should not be offered a slot reserved
  // for a different type — unless that would leave nothing to offer.
  let working = clean;
  let consultationTypeRelaxed = false;
  if (request.consultationTypeId) {
    const filtered = guardedFilter(working, (s) => s.consultationTypeId === null || s.consultationTypeId === request.consultationTypeId);
    working = filtered.slots;
    consultationTypeRelaxed = filtered.relaxed;
  }

  // Graceful attorney fallback (never a filter): note when the requested
  // attorney has no availability at all, so callers can be told honestly —
  // but every other attorney's slots still rank and return.
  const requestedAttorneyUnavailable = Boolean(
    request.attorneyId && !working.some((s) => s.attorneyId === request.attorneyId),
  );

  // RANK: additive composition of independent dimensions.
  const scored = working.map((slot, index) => {
    const facts = localFacts(slot.startsAt, timezone);
    let score = 0;
    const matchedDimensions = [];
    for (const scorer of SCORERS) {
      const result = scorer(slot, facts, policy, request);
      if (result) {
        score += result.points;
        matchedDimensions.push(result.dimension);
      }
    }
    return { ...slot, score, matchedDimensions, _index: index };
  });

  scored.sort((a, b) => (b.score - a.score)
    || (Date.parse(a.startsAt) - Date.parse(b.startsAt))
    || String(a.attorneyId ?? '~').localeCompare(String(b.attorneyId ?? '~'))
    || (a._index - b._index));

  const applied = [...new Set(scored.flatMap((s) => s.matchedDimensions))];
  const candidates = scored.slice(0, Math.max(1, limit)).map(({ _index, ...slot }) => slot);

  return {
    candidates,
    applied,
    fallback: { requestedAttorneyUnavailable, consultationTypeRelaxed },
    droppedSlots: dropped,
  };
}

module.exports = { selectSlots, sanitizeSlots, SCORERS, MORNING_END_HOUR };
