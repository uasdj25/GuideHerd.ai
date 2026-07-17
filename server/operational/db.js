'use strict';

/**
 * Operational Store database access — PostgreSQL connection pooling.
 *
 * Uses the maintained `pg` driver. This is the server's ONE deliberate
 * exception to the zero-runtime-dependency preference (recorded in
 * ADR-0006): hand-rolling the PostgreSQL wire protocol would be exactly the
 * kind of unsafe database code the rule exists to prevent.
 *
 * The pool is small by default: Railway's managed PostgreSQL plans cap
 * connections, and this API's traffic is modest. Override per deployment
 * with GUIDEHERD_PG_POOL_MAX.
 */

const { Pool } = require('pg');

const DEFAULT_POOL_MAX = 5;

/**
 * Resolve the operational database URL from the environment.
 * GUIDEHERD_OPERATIONAL_DATABASE_URL wins over DATABASE_URL (Railway injects
 * the latter when a PostgreSQL service is linked).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined}
 */
function operationalDatabaseUrl(env = process.env) {
  return env.GUIDEHERD_OPERATIONAL_DATABASE_URL || env.DATABASE_URL || undefined;
}

/**
 * Create a connection pool for the Operational Store.
 * Creation is lazy — no connection is attempted until the first query, so
 * callers that need fail-fast behavior (server boot) must run a real query
 * (the migration runner does) and treat failure as fatal.
 *
 * @param {{ connectionString?: string, max?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import('pg').Pool}
 */
function createOperationalPool({ connectionString, max, env = process.env } = {}) {
  const url = connectionString || operationalDatabaseUrl(env);
  if (!url) {
    throw new Error(
      'The Operational Store requires a PostgreSQL connection string: set '
      + 'DATABASE_URL (Railway) or GUIDEHERD_OPERATIONAL_DATABASE_URL.',
    );
  }
  return new Pool({
    connectionString: url,
    max: max || Number(env.GUIDEHERD_PG_POOL_MAX || DEFAULT_POOL_MAX),
  });
}

module.exports = { createOperationalPool, operationalDatabaseUrl };
