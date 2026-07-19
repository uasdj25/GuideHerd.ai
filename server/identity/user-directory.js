'use strict';

/**
 * GuideHerd User Directory (GitLab #65) — the store-backed user source
 * behind the dev-user authentication provider (ADR-0009/ADR-0013).
 *
 * Lives in the Configuration Store database (migration 0003-users) so the
 * Administration Framework can manage users with its existing guarantees:
 * transactional writes, audit rows, optimistic concurrency, organization
 * scoping. The directory itself is deliberately small and neutral — the
 * provider consumes it for login, the session layer consults it for live
 * revocation/role overlay, and the users administration area writes it.
 *
 * Credential discipline: this module NEVER sees a raw credential. Callers
 * pass SHA-256 digests; records returned by every method carry no
 * credential material at all (`credential_hash` is excluded structurally),
 * so audit snapshots built from records cannot leak it.
 */

const { ValidationError, UnknownEntityError, DuplicateKeyError } = require('../config/errors');

/** @param {object} row @returns {object} a public record — never the hash */
function present(row) {
  return {
    subject: row.subject,
    displayName: row.display_name ?? null,
    roles: JSON.parse(row.roles_json),
    active: row.active === 1,
    hasCredential: row.credential_hash !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSubject(subject) {
  if (typeof subject !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(subject)) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'subject', message: 'must be 2-64 chars: lowercase letters, digits, hyphens' },
    ]);
  }
  return subject;
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0
    || !roles.every((r) => typeof r === 'string' && r.trim() !== '')) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'roles', message: 'must be a nonempty array of role names' },
    ]);
  }
  return [...new Set(roles.map((r) => r.trim()))];
}

function normalizeDisplayName(displayName) {
  if (displayName === undefined || displayName === null) return null;
  if (typeof displayName !== 'string' || displayName.length > 120) {
    throw new ValidationError('One or more fields are invalid.', [
      { field: 'displayName', message: 'must be a string of at most 120 characters' },
    ]);
  }
  return displayName.trim() || null;
}

/**
 * @param {{ db: object, clock: import('../handoff/clock').Clock }} deps
 */
function createUserDirectory({ db, clock }) {
  const nowIso = () => new Date(clock.now()).toISOString();

  const stmt = {
    bySubject: db.prepare('SELECT * FROM users WHERE organization_key = ? AND subject = ?'),
    byHash: db.prepare('SELECT * FROM users WHERE credential_hash = ?'),
    list: db.prepare('SELECT * FROM users WHERE organization_key = ? ORDER BY subject'),
    insert: db.prepare(
      `INSERT INTO users (organization_key, subject, display_name, roles_json, active, credential_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ),
    countActiveWithRole: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE organization_key = ? AND active = 1 AND roles_json LIKE ?",
    ),
    countCredentialed: db.prepare(
      'SELECT COUNT(*) AS n FROM users WHERE active = 1 AND credential_hash IS NOT NULL',
    ),
  };

  function requireRow(organizationKey, subject) {
    const row = stmt.bySubject.get(organizationKey, subject);
    if (!row) throw new UnknownEntityError('user');
    return row;
  }

  function updateRow(organizationKey, subject, patchSql, params) {
    requireRow(organizationKey, subject);
    db.prepare(`UPDATE users SET ${patchSql}, updated_at = ? WHERE organization_key = ? AND subject = ?`)
      .run(...params, nowIso(), organizationKey, subject);
    return present(requireRow(organizationKey, subject));
  }

  return {
    list(organizationKey) {
      return stmt.list.all(organizationKey).map(present);
    },

    /** @returns {object|null} the public record, or null when absent */
    get(organizationKey, subject) {
      const row = stmt.bySubject.get(organizationKey, subject);
      return row ? present(row) : null;
    },

    /**
     * Create a user. `credentialHash` is the SHA-256 digest of an issued
     * credential (or null for a user who cannot sign in yet).
     */
    create(organizationKey, { subject, displayName, roles }, credentialHash = null) {
      const normalizedSubject = normalizeSubject(subject);
      if (stmt.bySubject.get(organizationKey, normalizedSubject)) {
        throw new DuplicateKeyError('user', normalizedSubject);
      }
      const now = nowIso();
      stmt.insert.run(
        organizationKey, normalizedSubject, normalizeDisplayName(displayName),
        JSON.stringify(normalizeRoles(roles)), credentialHash, now, now,
      );
      return present(requireRow(organizationKey, normalizedSubject));
    },

    update(organizationKey, subject, { displayName }) {
      return updateRow(organizationKey, subject, 'display_name = ?', [normalizeDisplayName(displayName)]);
    },

    setRoles(organizationKey, subject, roles) {
      return updateRow(organizationKey, subject, 'roles_json = ?', [JSON.stringify(normalizeRoles(roles))]);
    },

    setActive(organizationKey, subject, active) {
      return updateRow(organizationKey, subject, 'active = ?', [active ? 1 : 0]);
    },

    setCredentialHash(organizationKey, subject, credentialHash) {
      if (typeof credentialHash !== 'string' || credentialHash.length !== 64) {
        throw new ValidationError('One or more fields are invalid.', [
          { field: 'credential', message: 'internal: credential hash must be a SHA-256 hex digest' },
        ]);
      }
      return updateRow(organizationKey, subject, 'credential_hash = ?', [credentialHash]);
    },

    /**
     * Login path: resolve a credential digest to its user, including the
     * organization. Returns the public record + organizationKey, or null.
     * Deactivated users resolve too — the PROVIDER decides how to fail
     * (uniformly), so this layer stays policy-free.
     */
    findByCredentialHash(credentialHash) {
      const row = stmt.byHash.get(credentialHash);
      return row ? { ...present(row), organizationKey: row.organization_key } : null;
    },

    /** Active administrators in an organization (last-admin protection). */
    countActiveAdministrators(organizationKey) {
      return stmt.countActiveWithRole.get(organizationKey, '%"administrator"%').n;
    },

    /** Active sign-in-capable users across all organizations (capability health). */
    countCredentialed() {
      return stmt.countCredentialed.get().n;
    },
  };
}

module.exports = { createUserDirectory };
