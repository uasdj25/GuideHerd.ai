'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * TEMPORARY DEMO INFRASTRUCTURE (Slice 3) — Martinson & Beason demonstration.
 *
 * This bridge lets the external GuideHerd Scheduling Assistant runtime reach
 * a prepared session server-to-server, so the raw handoff token never leaves
 * this process. It is NOT production authentication: a single shared secret
 * (DEMO_BRIDGE_SECRET) authorizes the assistant's server tools. Production
 * telephony delivery of the handoff token replaces this entire module —
 * remove it (and its routes) at that point.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Endpoints served through app.js:
 *   POST /api/v1/demo/connect  — connect the matching prepared session
 *   POST /api/v1/demo/outcome  — record the scheduling outcome; triggers the
 *                                Consultation Summary + Outlook delivery
 *
 * Authentication moved onto the GuideHerd Identity Contract (ADR-0009): the
 * bridge secret (DEMO_BRIDGE_SECRET) is absorbed by the StaticTokenProvider
 * as the scheduling-assistant service identity, and the routes in app.js
 * authenticate through the identity middleware — this module no longer
 * inspects credentials. External behavior is unchanged: the credential is
 * accepted ONLY via `Authorization: Bearer`, compared as a SHA-256 digest,
 * and never logged.
 */

const { SessionStatus } = require('./status');
const { ValidationError } = require('./errors');

// The demo serves exactly one firm. Hardcoded on purpose: this module is
// temporary, and a config knob that dies with the demo isn't worth having.
const DEMO_FIRM_ID = 'martinson-beason';

const OUTCOME_STATUSES = [SessionStatus.BOOKED, SessionStatus.FAILED, SessionStatus.ESCALATED];

const OUTCOME_LIMITS = Object.freeze({
  schedulingSummary: 500,
  unresolvedQuestionItems: 10,
  unresolvedQuestionLength: 300,
  timezone: 64,
  startsAt: 64,
  id: 128,
});

/**
 * True when the value is a time-zone identifier the runtime's IANA database
 * accepts (dependency-free: Intl.DateTimeFormat throws RangeError otherwise).
 * Note: the runtime (ICU) also accepts a few legacy abbreviations such as
 * "CST"/"EST" as valid identifiers; unambiguous non-identifiers ("Central
 * Time", "Mars/Olympus") are rejected.
 */
function isIanaTimezone(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for a complete ISO-8601 datetime: date, time, and an explicit
 * UTC offset or `Z`. Date-only values and offset-less local datetimes are
 * rejected — a booked appointment must be unambiguous in absolute time.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
function isCompleteIsoDateTime(value) {
  return typeof value === 'string'
    && ISO_WITH_OFFSET.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reject unknown keys so provider payloads can't be smuggled through. */
function assertOnlyKeys(obj, allowed, where, details) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      details.push({ field: `${where}.${key}`, message: 'is not part of the GuideHerd outcome contract' });
    }
  }
}

/**
 * Validate a GuideHerd-owned outcome request body. Strict allowlist: unknown
 * keys (provider payloads, transcripts, legal content fields) are rejected.
 * @param {unknown} body
 * @returns {{ sessionId: string, outcome: object }}
 */
function normalizeOutcome(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('Request body must be a JSON object.', [
      { field: '(body)', message: 'must be a JSON object' },
    ]);
  }

  // FLAT-FORMAT TOLERANCE: the external assistant runtime's webhook editor
  // cannot practically construct the nested `outcome` object, so a flat body
  //   { sessionId, status, appointment, reason, ... }
  // is lifted into the canonical nested shape here, then flows through the
  // EXACT same validation below. `reason` is an alias for
  // `schedulingSummary`. A body carrying both `outcome` and flat fields is
  // rejected by the nested path's key allowlist (no ambiguity allowed).
  if (!('outcome' in body) && 'status' in body) {
    const flatDetails = [];
    assertOnlyKeys(body, ['sessionId', 'status', 'appointment', 'reason', 'schedulingSummary', 'unresolvedQuestions', 'escalationRequired'], '(body)', flatDetails);
    if (body.reason !== undefined && body.schedulingSummary !== undefined) {
      flatDetails.push({ field: 'reason', message: 'must not be combined with schedulingSummary' });
    }
    if (flatDetails.length > 0) {
      throw new ValidationError('One or more fields are invalid.', flatDetails);
    }
    const lifted = { status: body.status };
    if (body.appointment !== undefined) lifted.appointment = body.appointment;
    const summaryText = body.reason !== undefined ? body.reason : body.schedulingSummary;
    if (summaryText !== undefined) lifted.schedulingSummary = summaryText;
    if (body.unresolvedQuestions !== undefined) lifted.unresolvedQuestions = body.unresolvedQuestions;
    if (body.escalationRequired !== undefined) lifted.escalationRequired = body.escalationRequired;
    body = { sessionId: body.sessionId, outcome: lifted };
  }

  const details = [];
  assertOnlyKeys(body, ['sessionId', 'outcome'], '(body)', details);

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (sessionId === '' || sessionId.length > OUTCOME_LIMITS.id) {
    details.push({ field: 'sessionId', message: 'is required' });
  }

  const raw = isPlainObject(body.outcome) ? body.outcome : {};
  if (!isPlainObject(body.outcome)) {
    details.push({ field: 'outcome', message: 'is required' });
  }
  assertOnlyKeys(raw, ['status', 'appointment', 'schedulingSummary', 'unresolvedQuestions', 'escalationRequired'], 'outcome', details);

  const status = raw.status;
  if (!OUTCOME_STATUSES.includes(status)) {
    details.push({ field: 'outcome.status', message: `must be one of: ${OUTCOME_STATUSES.join(', ')}` });
  }

  let appointment = null;
  if (status === SessionStatus.BOOKED) {
    // booked requires a confirmed date/time and timezone
    const a = isPlainObject(raw.appointment) ? raw.appointment : {};
    if (!isPlainObject(raw.appointment)) {
      details.push({ field: 'outcome.appointment', message: 'is required when status is booked' });
    }
    assertOnlyKeys(a, ['startsAt', 'timezone', 'attorneyId', 'consultationTypeId'], 'outcome.appointment', details);

    const startsAt = typeof a.startsAt === 'string' ? a.startsAt.trim() : '';
    if (startsAt.length > OUTCOME_LIMITS.startsAt || !isCompleteIsoDateTime(startsAt)) {
      details.push({ field: 'outcome.appointment.startsAt', message: 'must be a complete ISO-8601 datetime with an explicit UTC offset or Z' });
    }
    const timezone = typeof a.timezone === 'string' ? a.timezone.trim() : '';
    if (timezone.length > OUTCOME_LIMITS.timezone || !isIanaTimezone(timezone)) {
      details.push({ field: 'outcome.appointment.timezone', message: 'must be a valid IANA time-zone identifier (e.g. America/Chicago)' });
    }
    appointment = { startsAt, timezone };
    for (const key of ['attorneyId', 'consultationTypeId']) {
      if (a[key] !== undefined) {
        if (typeof a[key] !== 'string' || a[key].trim() === '' || a[key].length > OUTCOME_LIMITS.id) {
          details.push({ field: `outcome.appointment.${key}`, message: 'must be a nonblank string' });
        } else {
          appointment[key] = a[key].trim();
        }
      }
    }
  } else if (raw.appointment !== undefined) {
    details.push({ field: 'outcome.appointment', message: 'is only accepted when status is booked' });
  }

  let schedulingSummary;
  if (raw.schedulingSummary !== undefined) {
    if (typeof raw.schedulingSummary !== 'string' || raw.schedulingSummary.length > OUTCOME_LIMITS.schedulingSummary) {
      details.push({ field: 'outcome.schedulingSummary', message: `must be a string of at most ${OUTCOME_LIMITS.schedulingSummary} characters` });
    } else {
      schedulingSummary = raw.schedulingSummary.trim();
    }
  }

  let unresolvedQuestions;
  if (raw.unresolvedQuestions !== undefined) {
    const list = raw.unresolvedQuestions;
    const valid = Array.isArray(list)
      && list.length <= OUTCOME_LIMITS.unresolvedQuestionItems
      && list.every((q) => typeof q === 'string' && q.length <= OUTCOME_LIMITS.unresolvedQuestionLength);
    if (!valid) {
      details.push({ field: 'outcome.unresolvedQuestions', message: `must be an array of at most ${OUTCOME_LIMITS.unresolvedQuestionItems} short strings` });
    } else {
      unresolvedQuestions = list.map((q) => q.trim()).filter((q) => q !== '');
    }
  }

  let escalationRequired;
  if (raw.escalationRequired !== undefined) {
    if (typeof raw.escalationRequired !== 'boolean') {
      details.push({ field: 'outcome.escalationRequired', message: 'must be a boolean' });
    } else {
      escalationRequired = raw.escalationRequired;
    }
  }

  if (details.length > 0) {
    throw new ValidationError('One or more fields are invalid.', details);
  }

  const outcome = { status };
  if (appointment) outcome.appointment = appointment;
  if (schedulingSummary !== undefined && schedulingSummary !== '') outcome.schedulingSummary = schedulingSummary;
  if (unresolvedQuestions !== undefined) outcome.unresolvedQuestions = unresolvedQuestions;
  if (escalationRequired !== undefined) outcome.escalationRequired = escalationRequired;
  return { sessionId, outcome };
}

/**
 * Record an outcome and deliver the Consultation Summary exactly once.
 *
 * Delivery idempotency: the repository's claimSummaryDelivery() grants the
 * delivery claim atomically (a synchronous check-and-mark in memory; a
 * conditional UPDATE in PostgreSQL), so concurrent duplicate outcome
 * requests — including requests on DIFFERENT API instances sharing one
 * database — can never both enter the send path. A retry is permitted after
 * 'failed' (and after a stale abandoned claim); a 'sent' summary is never
 * resent. Mail failure never reverses the recorded booking outcome — the
 * appointment and the notification are separate concerns.
 *
 * Since ADR-0011 §8, delivery itself is a NOTIFICATION: this workflow
 * states the intent through the summary notifier and mirrors the result
 * onto the session row. It no longer knows templates, HTML, providers,
 * or retry policy — the Notification Contract owns all of that (and the
 * durable outbox recovery consumer converges on the same claims).
 *
 * @param {{ service: any, store: any, summaryNotifier: { deliver: Function } }} deps
 * @param {string} sessionId
 * @param {object} outcome validated outcome
 * @param {{ correlationId?: string, organizationKey?: string }} [context] (Issue #8)
 * @returns {Promise<{ sessionId: string, status: string, summaryDelivery: string }>}
 */
async function recordOutcomeAndDeliver({ service, store, summaryNotifier }, sessionId, outcome, context = {}) {
  const { session } = await service.applyOutcome(sessionId, outcome, { correlationId: context.correlationId }); // throws on invalid transitions

  const claim = await store.claimSummaryDelivery(session.sessionId);
  let summaryDelivery = claim.summaryDelivery;
  if (claim.claimed) {
    const result = await summaryNotifier.deliver(claim.session, {
      correlationId: context.correlationId,
      organizationKey: context.organizationKey ?? session.firmId,
      sessionId: session.sessionId,
    });
    const updated = await store.recordSummaryDelivery(session.sessionId, result.status);
    summaryDelivery = updated.summaryDelivery; // 'sent' | 'failed' | 'not-configured'
  }

  return {
    sessionId: session.sessionId,
    status: session.status,
    summaryDelivery,
  };
}

module.exports = { normalizeOutcome, recordOutcomeAndDeliver, DEMO_FIRM_ID };
