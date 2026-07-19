'use strict';

/**
 * PostgreSQL integration delivery store (ADR-0020) — the durable
 * implementation of the delivery-idempotency contract, as a thin domain
 * wrapper over the platform's ONE PostgreSQL claim core
 * (server/reliability/claims.js): one atomic conditional INSERT/UPDATE,
 * multi-instance safe, 'completed' final forever. Nothing sensitive is
 * stored: keys carry GuideHerd identifiers only.
 */

const { createPostgresClaimCore, withKeyField } = require('../reliability/claims');

/**
 * @param {{ pool: import('pg').Pool, clock: import('../handoff/clock').Clock }} deps
 */
function createPostgresIntegrationDeliveryStore({ pool, clock }) {
  return withKeyField(createPostgresClaimCore({
    pool, clock, table: 'integration_deliveries', keyColumn: 'integration_key', finalStatus: 'completed',
  }), 'integrationKey');
}

module.exports = { createPostgresIntegrationDeliveryStore };
