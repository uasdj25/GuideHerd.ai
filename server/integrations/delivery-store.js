'use strict';

/**
 * Integration delivery store — the delivery-idempotency contract
 * (ADR-0020), as a thin domain wrapper over the platform's ONE
 * delivery-claim core (server/reliability/claims.js).
 *
 * One logical system-to-system effect exists per `integrationKey`, ever:
 * 'completed' is FINAL and never re-claimed — retries cannot duplicate
 * an effect in an external business system, across restarts and API
 * instances. The mechanics live in the shared core so the Notification
 * and Integration machines can never drift; only the domain vocabulary
 * lives here.
 */

const { createInMemoryClaimCore, withKeyField } = require('../reliability/claims');

/**
 * @param {{ clock: import('../handoff/clock').Clock }} deps
 */
function createInMemoryIntegrationDeliveryStore({ clock }) {
  return withKeyField(createInMemoryClaimCore({ clock, finalStatus: 'completed' }), 'integrationKey');
}

module.exports = { createInMemoryIntegrationDeliveryStore };
