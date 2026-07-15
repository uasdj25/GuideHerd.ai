'use strict';

/**
 * Scheduling options for the GuideHerd Console.
 *
 * This is the edge where the Configuration Store's industry-neutral terms
 * (service areas, providers, routing groups) are presented in GuideHerd
 * domain language (practice areas, attorneys). Nothing vendor- or
 * storage-specific crosses this boundary.
 */

/**
 * Build the scheduling options for one firm:
 *
 *   {
 *     practiceAreas: [ { id, name } ],                 // active, display order
 *     attorneysByPracticeArea: { [practiceAreaId]: [ { id, name } ] },
 *     consultationTypes: [ { id, name } ]               // active, display order
 *   }
 *
 * Every active practice area appears as a key in `attorneysByPracticeArea`;
 * an area with no active routing groups (or none with active members) maps
 * to an empty array, which the console renders as "No Attorneys Configured".
 * Attorneys reached through several routing groups for the same area are
 * de-duplicated.
 *
 * Consultation types are firm-wide (not filtered by practice area). The
 * console requires the receptionist to pick one of the firm's configured
 * types — there is no "not specified" fallback.
 *
 * @param {ReturnType<typeof import('./service').createConfigService>} configService
 * @param {string} firmId organization key
 * @throws {import('./errors').UnknownEntityError} unknown_organization
 */
function getSchedulingOptions(configService, firmId) {
  const areas = configService.serviceAreas.list(firmId, { activeOnly: true });
  const groups = configService.routingGroups.list(firmId, { activeOnly: true });
  const providers = configService.providers.list(firmId, { activeOnly: true });
  const consultationTypes = configService.consultationTypes.list(firmId, { activeOnly: true });

  const providerByKey = new Map(providers.map((p) => [p.key, p]));

  /** @type {Object<string, Array<{id: string, name: string}>>} */
  const attorneysByPracticeArea = {};
  for (const area of areas) {
    attorneysByPracticeArea[area.key] = [];
  }

  for (const group of groups) {
    const bucket = attorneysByPracticeArea[group.serviceArea];
    if (!bucket) continue; // group serves an inactive area — not offered
    for (const providerKey of group.providers) {
      const provider = providerByKey.get(providerKey);
      if (!provider) continue; // inactive providers are never offered
      if (!bucket.some((a) => a.id === providerKey)) {
        bucket.push({ id: providerKey, name: provider.displayName || provider.name });
      }
    }
  }

  return {
    practiceAreas: areas.map((a) => ({ id: a.key, name: a.name })),
    attorneysByPracticeArea,
    consultationTypes: consultationTypes.map((c) => ({ id: c.key, name: c.name })),
  };
}

module.exports = { getSchedulingOptions };
