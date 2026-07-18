'use strict';

/**
 * PostgreSQL notification delivery store (ADR-0011) — the durable
 * implementation of the delivery-idempotency contract, as a thin domain
 * wrapper over the platform's ONE PostgreSQL claim core
 * (server/reliability/claims.js): one atomic conditional INSERT/UPDATE,
 * multi-instance safe, 'sent' final forever. Nothing sensitive is
 * stored: keys carry GuideHerd identifiers only.
 */

const { createPostgresClaimCore, withKeyField } = require('../reliability/claims');

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresNotificationDeliveryStore({ pool, clock }) {
  return withKeyField(createPostgresClaimCore({
    pool, clock, table: 'notification_deliveries', keyColumn: 'notification_key', finalStatus: 'sent',
  }), 'notificationKey');
}

module.exports = { createPostgresNotificationDeliveryStore };
