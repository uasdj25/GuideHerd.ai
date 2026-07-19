'use strict';

/**
 * Live slot selection (ADR-0012 / GitLab #66) — the production seam where
 * provider-supplied availability becomes GuideHerd's offer.
 *
 * Providers answer "what is available?"; GuideHerd answers "what should
 * we offer?": the caller (the scheduling assistant's runtime, holding a
 * service identity) passes availability translated into the neutral slot
 * contract, and this module applies, in order:
 *
 *   1. sanitation      — malformed slots dropped and counted (engine);
 *   2. business hours  — a HARD constraint (hours.js): outside-hours
 *                        slots are never offered;
 *   3. policy          — the ADR-0012 engine filters (guarded, relaxing)
 *                        and ranks (additive, deterministic).
 *
 * Graceful degradation is preserved end to end: no policy → chronological
 * availability; preference filters relax rather than empty; and only the
 * firm's own hard hours rule can produce an empty offer — loudly.
 */

const { ValidationError } = require('../handoff/errors');
const { selectSlots, sanitizeSlots } = require('./engine');
const { resolveSchedulingPolicy } = require('./policy');
const { applyBusinessHoursConstraint } = require('./hours');

const MAX_SLOTS = 200; // bounded input: a provider dumping more is a caller bug

/**
 * @param {{
 *   configService: object,
 *   organizationKey: string,
 *   slots: unknown,
 *   request?: { attorneyId?: string, consultationTypeId?: string, durationMinutes?: number },
 *   limit?: number,
 *   telemetry?: { event: Function },
 *   correlationId?: string,
 *   sessionId?: string,
 * }} args
 */
function selectOfferedSlots({
  configService, organizationKey, slots, request = {}, limit = 10,
  telemetry, correlationId, sessionId,
}) {
  if (!Array.isArray(slots)) {
    throw new ValidationError('slots must be an array of availability slots.', [
      { field: 'slots', message: 'must be an array' },
    ]);
  }
  if (slots.length > MAX_SLOTS) {
    throw new ValidationError(`slots is capped at ${MAX_SLOTS} entries per selection.`, [
      { field: 'slots', message: `at most ${MAX_SLOTS} entries` },
    ]);
  }
  const emit = telemetry ? telemetry.event.bind(telemetry) : () => {};

  const organization = configService.organizations.get(organizationKey); // throws unknown_organization
  const locations = configService.locations.list(organizationKey, {});

  const { slots: clean, dropped } = sanitizeSlots(slots);
  const hours = applyBusinessHoursConstraint({
    slots: clean, locations, orgTimezone: organization.timezone,
  });
  const { policy } = resolveSchedulingPolicy(configService, organizationKey);
  const selection = selectSlots({
    slots: hours.slots, policy, request, timezone: organization.timezone, limit,
  });

  emit('scheduling.slots_selected', {
    severity: 'info',
    component: 'scheduling',
    operation: 'slot-selection',
    organizationKey,
    sessionId,
    correlationId,
    receivedCount: slots.length,
    offeredCount: selection.candidates.length,
    removedCount: hours.removed + dropped,
  });
  if (slots.length > 0 && selection.candidates.length === 0 && hours.removed > 0) {
    // The firm's own booking rules excluded everything the calendar had —
    // legitimate, but an administrator should see it happening.
    emit('scheduling.slots_exhausted', {
      severity: 'warn',
      component: 'scheduling',
      operation: 'slot-selection',
      organizationKey,
      sessionId,
      correlationId,
      receivedCount: slots.length,
      removedCount: hours.removed,
    });
  }

  return {
    slots: selection.candidates,
    applied: {
      policy: policy !== null,
      dimensions: selection.applied,
      businessHours: hours.status,
      removedOutsideHours: hours.removed,
      unscopedSlots: hours.unscoped,
      droppedMalformed: dropped,
      fallback: selection.fallback,
    },
  };
}

module.exports = { selectOfferedSlots, MAX_SLOTS };
