#!/usr/bin/env node
'use strict';

/**
 * Render the effective ElevenLabs system prompt for one organization from
 * the Configuration Store (SQLite) — the tenant-specific artifact that is
 * pasted into the ElevenLabs agent. The canonical source is the template
 * (connect/prompts/law-firm-scheduling.template.md); this script only
 * substitutes configured tenant values and refuses to emit anything with
 * unresolved placeholders.
 *
 *   node --experimental-sqlite scripts/render-scheduling-prompt.js \
 *     --db guideherd-config.db --organization martinson-beason [--out <file>]
 *
 * Without --out the rendered prompt goes to stdout. Read-only apart from
 * applying any pending Configuration Store migrations (idempotent, the
 * same behavior as every other store CLI).
 */

const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { renderSchedulingPromptArtifact, PromptConfigurationError } = require('../connect/prompt-renderer');

const USAGE = 'Usage: node --experimental-sqlite scripts/render-scheduling-prompt.js --db <file.db> --organization <key> [--out <file>]';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) args.dbPath = argv[(i += 1)];
    else if (argv[i] === '--organization' && argv[i + 1]) args.organizationKey = argv[(i += 1)];
    else if (argv[i] === '--out' && argv[i + 1]) args.outPath = argv[(i += 1)];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
  }
  if (!args.dbPath || !args.organizationKey) {
    throw new Error(`Both --db and --organization are required.\n${USAGE}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exitCode = 1;
    return;
  }
  const db = openDatabase({ path: args.dbPath });
  try {
    migrate(db);
    const configService = createConfigService({ db });
    const { prompt, provenance } = renderSchedulingPromptArtifact({
      configService, organizationKey: args.organizationKey,
    });
    if (args.outPath) {
      const outPath = path.resolve(args.outPath);
      fs.writeFileSync(outPath, prompt);
      // Sidecar provenance: which template + configuration produced the
      // artifact that gets pasted into the agent. Deterministic hashes,
      // so regeneration from unchanged inputs is diff-stable.
      fs.writeFileSync(`${outPath.replace(/\.md$/, '')}.provenance.json`,
        `${JSON.stringify(provenance, null, 2)}\n`);
      console.error(JSON.stringify({ level: 'info', message: 'Prompt rendered.', out: args.outPath, ...provenance }));
    } else {
      process.stdout.write(prompt);
      console.error(JSON.stringify({ level: 'info', message: 'Prompt rendered.', ...provenance }));
    }
  } catch (err) {
    if (err instanceof PromptConfigurationError) {
      console.error(err.message);
    } else {
      console.error(String(err.message || err));
    }
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
