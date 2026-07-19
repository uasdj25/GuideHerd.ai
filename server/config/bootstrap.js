'use strict';

/**
 * Configuration bootstrap (ADR-0022, GitLab #59).
 *
 * Decides what a seed document means at boot. The persistent configuration
 * store — written through the Administration Framework — is the authoritative
 * source of configuration; a seed document is a one-time bootstrap input
 * unless a deployment explicitly opts into recurring re-import.
 *
 * GUIDEHERD_SEED_MODE:
 *   bootstrap (default) — import the document only when its organization does
 *                         not exist in the store yet. Once an organization is
 *                         present, live configuration wins and boot-time
 *                         import is skipped with a loud log line. A stale
 *                         seed file can never overwrite newer live edits.
 *   always              — re-import (upsert) on every boot: the historical
 *                         git-as-source-of-truth mode, retained for demos and
 *                         deliberately ephemeral hosts. Explicit, loudly
 *                         warned at boot, and surfaced as `seed-managed`
 *                         on the health/administration surfaces.
 *
 * Any other value refuses to start — no guessing, no silent fallback.
 * The intentional re-import path for a live deployment is the existing
 * operator-run CLI (`npm run config:seed`), never startup.
 */

const { loadSeedDocument } = require('./seed');

const SEED_MODES = ['bootstrap', 'always'];

/**
 * Parse GUIDEHERD_SEED_MODE. Unknown values throw (boot must fail loudly).
 * @param {string|undefined} raw
 * @returns {'bootstrap'|'always'}
 */
function resolveSeedMode(raw) {
  const value = String(raw ?? 'bootstrap').trim().toLowerCase() || 'bootstrap';
  if (!SEED_MODES.includes(value)) {
    throw new Error(
      `GUIDEHERD_SEED_MODE must be one of ${SEED_MODES.join('|')}; got "${raw}".`
    );
  }
  return value;
}

/**
 * Apply the seed document per the resolved mode. Throws on an unreadable or
 * invalid document (callers fail the boot). Import validity/atomicity is the
 * config service's: full validation precedes one transaction.
 *
 * @param {{ configService: object, filePath: string|undefined,
 *           mode: 'bootstrap'|'always', log?: (entry: object) => void }} args
 * @returns {{ action: 'none' } |
 *           { action: 'skipped', organization: string } |
 *           { action: 'imported', organization: string, counts: Object<string, number> }}
 */
function seedOnBoot({ configService, filePath, mode, log = () => {} }) {
  if (!filePath) return { action: 'none' };
  const tree = loadSeedDocument(filePath);
  const organizationKey = String(
    (tree && typeof tree === 'object' && tree.organization && tree.organization.key) || ''
  ).trim();

  if (mode === 'bootstrap' && organizationKey
      && configService.organizations.list().some((o) => o.key === organizationKey)) {
    log({
      level: 'info',
      message: 'Seed bootstrap skipped: organization already present; live configuration is authoritative.',
      organization: organizationKey,
      seedMode: mode,
    });
    return { action: 'skipped', organization: organizationKey };
  }

  if (mode === 'always') {
    log({
      level: 'warn',
      message: 'Recurring seed re-import (GUIDEHERD_SEED_MODE=always): administration changes will be overwritten at every boot.',
      seedFile: filePath,
      seedMode: mode,
    });
  }

  const result = configService.importOrganization(tree);
  return { action: 'imported', ...result };
}

/**
 * The configuration-authority descriptor surfaced on the Operations Center
 * capability list and the Administration describe() payload.
 *
 * Three states, because durability must be EVIDENCED, not assumed:
 *   seed-managed       — always mode: edits are overwritten at every boot.
 *   bootstrap-imported — bootstrap mode imported THIS boot: either the first
 *                        boot of a durable deployment, or an ephemeral
 *                        filesystem wiping the store between boots. The two
 *                        are indistinguishable from inside one boot, so this
 *                        state promises nothing; a restart that skips the
 *                        import is what proves durability (→ live).
 *   live               — the store pre-existed this boot; administration
 *                        writes are authoritative and survive restarts.
 *
 * @param {{ filePath: string|undefined, mode: 'bootstrap'|'always'|null,
 *           result: { action: string }|null }} args
 * @returns {{ mode: 'live'|'seed-managed'|'bootstrap-imported',
 *             seedOnBoot: boolean, lastBootImport: string }}
 */
function describeAuthority({ filePath, mode, result }) {
  let authorityMode = 'live';
  if (filePath && mode === 'always') authorityMode = 'seed-managed';
  else if (result && result.action === 'imported') authorityMode = 'bootstrap-imported';
  return {
    mode: authorityMode,
    seedOnBoot: Boolean(filePath),
    lastBootImport: result ? result.action : 'none',
  };
}

module.exports = { resolveSeedMode, seedOnBoot, describeAuthority, SEED_MODES };
