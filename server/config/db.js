'use strict';

/**
 * SQLite database access for the Configuration Store.
 *
 * Uses the Node.js built-in `node:sqlite` module — no external dependency,
 * matching this server's zero-runtime-dependency rule. `node:sqlite` shipped
 * in Node 22.5 behind `--experimental-sqlite` and is available without the
 * flag from Node 22.13 / 23.4 onward. The flag is baked into this package's
 * npm scripts and is accepted harmlessly on newer versions.
 */

/** Loads DatabaseSync or throws a message that explains how to enable it. */
function loadSqlite() {
  try {
    // Lazy so that merely requiring other config modules never needs sqlite.
    return require('node:sqlite');
  } catch (err) {
    throw new Error(
      'node:sqlite is not available. The Configuration Store requires Node >= 22.5; ' +
      'on Node < 22.13 (or < 23.4) run with --experimental-sqlite ' +
      '(the provided npm scripts already do).',
    );
  }
}

/**
 * Open (creating if necessary) a Configuration Store database.
 *
 * @param {{ path?: string }} [options] `:memory:` (default) or a file path.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDatabase({ path = ':memory:' } = {}) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);

  // Referential integrity is part of the schema contract.
  db.exec('PRAGMA foreign_keys = ON;');

  // WAL keeps readers unblocked during writes and is the backup-friendly
  // default for a file-backed embedded database. Meaningless for :memory:.
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  return db;
}

module.exports = { openDatabase };
