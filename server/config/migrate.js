'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { MigrationError } = require('./errors');
const { systemClock } = require('./clock');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Apply pending schema migrations, oldest first.
 *
 * Migrations are plain SQL files named `NNNN-description.sql` (e.g.
 * `0001-initial.sql`). Each file is applied inside its own transaction and
 * recorded in `schema_migrations`; a failing migration rolls back completely
 * and stops the run. Already-applied versions are skipped, so calling this on
 * every startup is safe and is the intended usage.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ migrationsDir?: string, clock?: import('./clock').Clock }} [options]
 * @returns {string[]} versions applied by this run (empty when up to date)
 */
function migrate(db, { migrationsDir = DEFAULT_MIGRATIONS_DIR, clock = systemClock() } = {}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    '  version    TEXT PRIMARY KEY,' +
    '  applied_at TEXT NOT NULL' +
    ')',
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort();

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
  );

  const appliedNow = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date(clock.now()).toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new MigrationError(version, err);
    }
    appliedNow.push(version);
  }

  return appliedNow;
}

module.exports = { migrate, DEFAULT_MIGRATIONS_DIR };
