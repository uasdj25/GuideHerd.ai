#!/usr/bin/env node
'use strict';

/**
 * Configuration Store seed CLI.
 *
 * Applies pending migrations, then imports (upserts) one organization
 * configuration document:
 *
 *   npm run config:seed -- --db guideherd-config.db --file config/data/martinson-beason.example.json
 *
 * Or directly (the --experimental-sqlite flag is needed on Node < 22.13 / 23.4):
 *
 *   node --experimental-sqlite config/seed.js --db <file.db> --file <config.json>
 *
 * Import is non-destructive: entities are upserted by key; entities absent
 * from the document are left untouched. Safe to re-run.
 */

const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('./db');
const { migrate } = require('./migrate');
const { createConfigService } = require('./service');
const { ConfigError } = require('./errors');

const USAGE = 'Usage: node --experimental-sqlite config/seed.js --db <file.db> --file <config.json>';

/**
 * Parse CLI arguments. Exported for tests.
 * @param {string[]} argv arguments after the script name
 * @returns {{ dbPath: string, filePath: string }}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) {
      args.dbPath = argv[(i += 1)];
    } else if (argv[i] === '--file' && argv[i + 1]) {
      args.filePath = argv[(i += 1)];
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    }
  }
  if (!args.dbPath || !args.filePath) {
    throw new Error(`Both --db and --file are required.\n${USAGE}`);
  }
  return args;
}

/**
 * Migrate the database and import the document. Exported for tests.
 * @param {{ dbPath: string, filePath: string }} args
 * @returns {{ migrationsApplied: string[], organization: string, counts: Object<string, number> }}
 */
function run({ dbPath, filePath }) {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  let tree;
  try {
    tree = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Configuration file is not valid JSON: ${filePath}`);
  }

  const db = openDatabase({ path: dbPath });
  try {
    const migrationsApplied = migrate(db);
    const service = createConfigService({ db });
    const result = service.importOrganization(tree);
    return { migrationsApplied, ...result };
  } finally {
    db.close();
  }
}

function main() {
  let result;
  try {
    result = run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(JSON.stringify({ level: 'error', ...err.toBody() }));
    } else {
      console.error(String(err.message || err));
    }
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    level: 'info',
    message: 'Configuration imported.',
    migrationsApplied: result.migrationsApplied,
    organization: result.organization,
    counts: result.counts,
  }));
}

if (require.main === module) main();

module.exports = { parseArgs, run };
