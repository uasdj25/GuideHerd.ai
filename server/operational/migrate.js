'use strict';

/**
 * Operational Store migrations — numbered SQL files applied in order, the
 * same pattern proven by config/migrate.js, adapted for PostgreSQL:
 *
 *  - Applied migrations are recorded in `operational_schema_migrations`.
 *  - Each migration runs inside its own transaction (PostgreSQL DDL is
 *    transactional), so a failing migration leaves nothing half-applied.
 *  - A session-scoped advisory lock serializes concurrent runners: when
 *    several API instances boot at once during a deploy, exactly one applies
 *    pending migrations and the others wait, then see them as applied.
 *  - Migrations are ADDITIVE-ONLY by policy (ADR-0006): Railway overlaps old
 *    and new instances during a deploy, so the previous release must keep
 *    working against the migrated schema.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Arbitrary but stable application-wide advisory lock key for migrations. */
const MIGRATION_LOCK_KEY = 728301;

/**
 * Apply pending migrations. Safe to call from every instance at boot.
 * @param {import('pg').Pool} pool
 * @param {{ dir?: string }} [options]
 * @returns {Promise<number>} number of migrations applied by THIS call
 */
async function migrate(pool, { dir = MIGRATIONS_DIR } = {}) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{4}-[\w-]+\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS operational_schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL
      )`);

    const { rows } = await client.query('SELECT name FROM operational_schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO operational_schema_migrations (name, applied_at) VALUES ($1, now())',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      count += 1;
    }
    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate, MIGRATION_LOCK_KEY };
