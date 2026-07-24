'use strict';

/**
 * Tenant scheduling readiness (GitLab #77) — the explicit, evaluable
 * answer to "can this organization actually schedule natively?", built
 * so an incompletely provisioned tenant can never be PRESENTED as ready
 * (the Martinson & Beason coverage-gap lesson: five of seven attorneys
 * looked configured and were unschedulable).
 *
 * Four DISTINCT per-attorney states, never collapsed:
 *   1. exists       — the attorney is in the provider catalog;
 *   2. schedulable  — the tenant has ENABLED the attorney for scheduling
 *                     (calendar-targets.schedulableAttorneys);
 *   3. bound        — the attorney holds a calendar binding;
 *   4. (tenant) ready — the organization as a whole may schedule.
 *
 * Readiness is STRICT regardless of the tenant's refusal-time
 * full-coverage rule: an enabled attorney without a binding always
 * makes the tenant NOT ready — the declarable rule only controls
 * whether such a configuration can be WRITTEN at all
 * (validateSchedulingTargetsCrossEntity).
 *
 * Consumed by the Administration Portal (#91), the Operations Center
 * (#92), and the cutover gate (#96). Pure read; no side effects.
 */

const { readDomain } = require('../configuration/framework');
const { validateSchedulingTargetsCrossEntity } = require('./scheduling-targets');

/**
 * @param {{ configService: object, organizationKey: string,
 *           calendarProviderKeys?: string[]|null }} args
 * @returns {{
 *   ready: boolean,
 *   provider: string|null,
 *   issues: string[],                       every reason the tenant is not ready
 *   attorneys: Array<{ key: string, name: string, active: boolean,
 *                      schedulable: boolean, bound: boolean,
 *                      calendarRef: string|null }>,
 *   enabledUnbound: string[],               the coverage gap, by attorney key
 *   defaultCalendarConfigured: boolean,
 *   routingGroups: Array<{ key: string, serviceArea: string, active: boolean,
 *                          covered: boolean, via: 'group-calendar'|'member-pool'|null }>,
 * }}
 */
function evaluateSchedulingReadiness({ configService, organizationKey, calendarProviderKeys = null }) {
  const { value: config } = readDomain(configService, 'calendar-targets', organizationKey);
  const issues = [];

  // The stored document must itself survive the strict producer rules —
  // readiness never vouches for configuration the gate would refuse.
  issues.push(...validateSchedulingTargetsCrossEntity(config, {
    configService, organizationKey,
    ...(calendarProviderKeys ? { calendarProviderKeys } : {}),
  }));

  const catalog = configService.providers.list(organizationKey, {});
  const schedulable = new Set(config.schedulableAttorneys);
  const attorneys = catalog.map((a) => ({
    key: a.key,
    name: a.displayName || a.name,
    active: a.active !== false,
    schedulable: schedulable.has(a.key),
    bound: Boolean(config.attorneyCalendars[a.key]),
    calendarRef: config.attorneyCalendars[a.key] || null,
  }));
  const enabledUnbound = attorneys
    .filter((a) => a.active && a.schedulable && !a.bound)
    .map((a) => a.key);
  for (const key of enabledUnbound) {
    issues.push(`attorney "${key}" is enabled for scheduling but has no calendar binding`);
  }

  let groups = [];
  try { groups = configService.routingGroups.list(organizationKey); } catch { groups = []; }
  const routingGroups = groups.map((g) => {
    const members = Array.isArray(g.providers) ? g.providers : [];
    const via = config.routingGroupCalendars[g.key]
      ? 'group-calendar'
      : (members.length > 0 && members.every((m) => config.attorneyCalendars[m]) ? 'member-pool' : null);
    return {
      key: g.key,
      serviceArea: g.serviceArea,
      active: g.active !== false,
      covered: via !== null,
      via,
    };
  });

  if (!config.provider) {
    issues.push('no native calendar provider is selected');
  }
  const anyRoute = Boolean(config.defaultCalendar)
    || Object.keys(config.attorneyCalendars).length > 0
    || routingGroups.some((g) => g.active && g.covered);
  if (config.provider && !anyRoute) {
    issues.push('no route is schedulable: no calendar binding, group coverage, or default calendar exists');
  }

  return {
    ready: issues.length === 0,
    provider: config.provider,
    issues,
    attorneys,
    enabledUnbound,
    defaultCalendarConfigured: Boolean(config.defaultCalendar),
    routingGroups,
  };
}

module.exports = { evaluateSchedulingReadiness };
