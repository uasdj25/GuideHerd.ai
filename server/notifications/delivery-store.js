'use strict';

/**
 * Notification delivery store — the delivery-idempotency contract
 * (ADR-0011), as a thin domain wrapper over the platform's ONE
 * delivery-claim core (server/reliability/claims.js).
 *
 * One logical customer notification exists per `notificationKey`, ever:
 * a claim is granted when the key has never been attempted, previously
 * failed, or a prior 'pending' claim is stale; 'sent' is FINAL and never
 * re-claimed — retries cannot duplicate a customer notification, across
 * restarts and API instances. The mechanics live in the shared core so
 * the Notification and Integration machines can never drift; only the
 * domain vocabulary (key field name, final-status name) lives here.
 */

const { createInMemoryClaimCore, withKeyField } = require('../reliability/claims');

/**
 * @param {{ clock: import('../handoff/clock').Clock }} deps
 */
function createInMemoryNotificationDeliveryStore({ clock }) {
  return withKeyField(createInMemoryClaimCore({ clock, finalStatus: 'sent' }), 'notificationKey');
}

module.exports = { createInMemoryNotificationDeliveryStore };
