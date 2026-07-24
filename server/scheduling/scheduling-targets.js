'use strict';

/**
 * The GuideHerd Scheduling Target Domain (GitLab #76) — the
 * provider-neutral configuration native scheduling routes against.
 *
 * The Core reasons about GUIDEHERD concepts only: attorneys, routing
 * groups, practice areas, appointment types, durations, and CALENDAR
 * TARGETS (opaque provider-scoped calendar references, ADR-0024). It
 * never reasons about a provider artifact — the legacy event-type
 * mapping (`scheduling/calcom-availability`) remains the TRANSITIONAL
 * configuration of the deployed provider path, isolated in its own
 * domain and modules, removed at decommission (#97). Nothing here reads
 * or writes it.
 *
 * DARK BY DEFAULT: `provider: null` means native scheduling is not
 * configured for the organization — registering this domain changes
 * NOTHING for existing tenants; the deployed provider path keeps serving
 * production until the controlled cutover (#96) selects otherwise,
 * per-tenant, through this same governed configuration.
 *
 * The `scheduling/calendar-targets` settings document:
 *
 *   {
 *     "provider": "<calendar provider key>" | null,   // tenant's active
 *          // NATIVE calendar provider (ADR-0024 registry key). null =
 *          // native scheduling unconfigured (fail closed).
 *     "defaultCalendar": "<calendarRef>" | null,      // the EXPLICIT
 *          // permission for the no-context path; absent = that path is
 *          // not permitted (fail closed), exactly like the deployed
 *          // default-event-type rule.
 *     "attorneyCalendars":     { "<attorneyKey>": "<calendarRef>" },
 *     "routingGroupCalendars": { "<groupKey>":   "<calendarRef>" },
 *          // optional provider-side shared calendar for a group; when
 *          // absent, a fully-bound member pool serves the group and the
 *          // Core owns distribution (#79).
 *     "appointmentDurations":  { "<consultationTypeKey>": minutes },
 *     "defaultDurationMinutes": 30
 *   }
 *
 * Routing preserves the deployed precedence and fail-closed semantics
 * EXACTLY (same `routing_unresolved` reason enum, same `routeKind`
 * telemetry values); only the resolved artifact changes — calendar
 * targets instead of provider event types. Availability and booking
 * keep sharing ONE durable routing decision: the resolved target set is
 * persisted in the booking context (#80) and booking never re-resolves.
 */

const { AvailabilityError, RoutingUnresolvedError } = require('./availability');

const CONFIG_FIELDS = [
  'provider', 'defaultCalendar', 'attorneyCalendars', 'routingGroupCalendars',
  'appointmentDurations', 'defaultDurationMinutes',
];
const MAX_CALENDAR_REF = 512;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalize the `scheduling/calendar-targets` settings document. LENIENT
 * reads (consumers fail closed on what is missing); STRICT issues for
 * the producer gate. Cross-entity rules (real active attorneys, active
 * unambiguous groups, tenant readiness) are #77's validate() — this is
 * shape only.
 */
function normalizeSchedulingTargetsConfig(raw) {
  const empty = {
    provider: null,
    defaultCalendar: null,
    attorneyCalendars: {},
    routingGroupCalendars: {},
    appointmentDurations: {},
    defaultDurationMinutes: 30,
  };
  if (raw === null || raw === undefined) return { value: empty, issues: [] };
  if (!isPlainObject(raw)) {
    return { value: empty, issues: ['must be an object like { "provider": "…", "attorneyCalendars": { … } }'] };
  }
  const issues = [];
  for (const k of Object.keys(raw)) {
    if (!CONFIG_FIELDS.includes(k)) issues.push(`unknown field: ${k}`);
  }
  const calendarRef = (field, value) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_CALENDAR_REF) {
      issues.push(`${field} must be a nonblank calendar reference of at most ${MAX_CALENDAR_REF} characters`);
      return null;
    }
    return value.trim();
  };
  let provider = null;
  if (raw.provider !== undefined && raw.provider !== null) {
    if (typeof raw.provider === 'string' && raw.provider.trim() !== '') provider = raw.provider.trim();
    else issues.push('provider must be a nonblank calendar provider key or null');
  }
  let defaultCalendar = null;
  if (raw.defaultCalendar !== undefined && raw.defaultCalendar !== null) {
    defaultCalendar = calendarRef('defaultCalendar', raw.defaultCalendar);
  }
  const refMap = (field, keyNoun) => {
    const map = {};
    if (raw[field] === undefined) return map;
    if (!isPlainObject(raw[field])) {
      issues.push(`${field} must map ${keyNoun} keys to calendar references`);
      return map;
    }
    for (const [key, ref] of Object.entries(raw[field])) {
      if (typeof key !== 'string' || key.trim() === '') {
        issues.push(`${field} keys must be nonblank ${keyNoun} keys`);
        continue;
      }
      const cleaned = calendarRef(`${field}.${key}`, ref);
      if (cleaned) map[key.trim()] = cleaned;
    }
    return map;
  };
  const attorneyCalendars = refMap('attorneyCalendars', 'attorney');
  const routingGroupCalendars = refMap('routingGroupCalendars', 'routing-group');
  const appointmentDurations = {};
  if (raw.appointmentDurations !== undefined) {
    if (!isPlainObject(raw.appointmentDurations)) {
      issues.push('appointmentDurations must map consultation type keys to minutes');
    } else {
      for (const [key, minutes] of Object.entries(raw.appointmentDurations)) {
        if (typeof key !== 'string' || key.trim() === '') {
          issues.push('appointmentDurations keys must be nonblank consultation type keys');
        } else if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
          issues.push(`appointmentDurations.${key} must be an integer between 1 and 480`);
        } else {
          appointmentDurations[key.trim()] = minutes;
        }
      }
    }
  }
  let defaultDurationMinutes = 30;
  if (raw.defaultDurationMinutes !== undefined) {
    if (Number.isInteger(raw.defaultDurationMinutes)
      && raw.defaultDurationMinutes > 0 && raw.defaultDurationMinutes <= 480) {
      defaultDurationMinutes = raw.defaultDurationMinutes;
    } else {
      issues.push('defaultDurationMinutes must be an integer between 1 and 480');
    }
  }
  return {
    value: {
      provider, defaultCalendar, attorneyCalendars, routingGroupCalendars,
      appointmentDurations, defaultDurationMinutes,
    },
    issues,
  };
}

/** Appointment duration policy: the appointment type owns its duration. */
function resolveAppointmentDuration(config, consultationTypeId = null) {
  if (consultationTypeId && Number.isInteger(config.appointmentDurations[consultationTypeId])) {
    return config.appointmentDurations[consultationTypeId];
  }
  return config.defaultDurationMinutes;
}

/**
 * Resolve the ONE provider-neutral routing decision an availability check
 * and its subsequent booking share (the native successor of the deployed
 * event-type resolver — same precedence, same fail-closed reasons, same
 * routeKind telemetry values; the resolved artifact is a CALENDAR TARGET
 * set).
 *
 * Precedence (every miss FAILS CLOSED — nothing ever guesses a calendar):
 *
 *  1. attorney + practice area — honored only when the attorney is a
 *     member of the single active routing group for that area AND has a
 *     calendar binding. Membership-as-eligibility remains the tenant's
 *     configured policy, not a platform assumption.
 *  2. attorney only — that attorney's calendar binding.
 *  3. practice area only — exactly one active routing group for the
 *     area; then the group's provider-side calendar when bound, else the
 *     FULLY-bound member pool (Core-owned distribution, #79). A
 *     partially bound pool fails closed — a group never silently
 *     shrinks to whoever happens to be bound.
 *  4. neither — the explicit defaultCalendar, ONLY because its presence
 *     is the tenant's permission for the default path.
 *
 * Inputs are catalog-validated upstream (unknown/inactive keys are 400s
 * before resolution runs), exactly as deployed.
 *
 * @returns {{ routeKind: 'attorney'|'routing-group'|'default',
 *             attorneyId: string|null, routingGroupKey: string|null,
 *             practiceAreaId: string|null,
 *             targets: Array<{ attorneyId: string|null, calendarRef: string }> }}
 * @throws {RoutingUnresolvedError|AvailabilityError} fail closed
 */
function resolveSchedulingTarget({ config, attorneyId = null, practiceAreaId = null, routingGroups = [] }) {
  const singleActiveGroupFor = (areaKey) => {
    const groups = routingGroups.filter((g) => g.active !== false && g.serviceArea === areaKey);
    if (groups.length === 0) {
      throw new RoutingUnresolvedError('no_routing_group',
        `No active routing group serves practice area "${areaKey}".`);
    }
    if (groups.length > 1) {
      throw new RoutingUnresolvedError('ambiguous_routing_group',
        `More than one active routing group serves practice area "${areaKey}".`);
    }
    return groups[0];
  };
  const attorneyRoute = (withArea) => {
    const calendarRef = config.attorneyCalendars[attorneyId];
    if (!calendarRef) {
      throw new RoutingUnresolvedError('attorney_unmapped',
        `Attorney "${attorneyId}" has no configured calendar binding.`);
    }
    return {
      routeKind: 'attorney', attorneyId,
      routingGroupKey: null, practiceAreaId: withArea ? practiceAreaId : null,
      targets: [{ attorneyId, calendarRef }],
    };
  };

  if (attorneyId && practiceAreaId) {
    const group = singleActiveGroupFor(practiceAreaId);
    if (!Array.isArray(group.providers) || !group.providers.includes(attorneyId)) {
      throw new RoutingUnresolvedError('attorney_not_permitted',
        `Attorney "${attorneyId}" is not configured for practice area "${practiceAreaId}".`);
    }
    return attorneyRoute(true);
  }
  if (attorneyId) return attorneyRoute(false);
  if (practiceAreaId) {
    const group = singleActiveGroupFor(practiceAreaId);
    const groupCalendar = config.routingGroupCalendars[group.key];
    if (groupCalendar) {
      return {
        routeKind: 'routing-group', attorneyId: null,
        routingGroupKey: group.key, practiceAreaId,
        targets: [{ attorneyId: null, calendarRef: groupCalendar }],
      };
    }
    const members = Array.isArray(group.providers) ? group.providers : [];
    if (members.length > 0 && members.every((m) => config.attorneyCalendars[m])) {
      return {
        routeKind: 'routing-group', attorneyId: null,
        routingGroupKey: group.key, practiceAreaId,
        targets: members.map((m) => ({ attorneyId: m, calendarRef: config.attorneyCalendars[m] })),
      };
    }
    throw new RoutingUnresolvedError('routing_group_unmapped',
      `Routing group "${group.key}" has no configured calendar coverage.`);
  }
  if (config.defaultCalendar) {
    return {
      routeKind: 'default', attorneyId: null,
      routingGroupKey: null, practiceAreaId: null,
      targets: [{ attorneyId: null, calendarRef: config.defaultCalendar }],
    };
  }
  throw new AvailabilityError('availability_not_configured',
    'No default calendar is configured for this organization.');
}

module.exports = {
  normalizeSchedulingTargetsConfig,
  resolveSchedulingTarget,
  resolveAppointmentDuration,
};
