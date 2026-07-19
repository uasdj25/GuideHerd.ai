-- GuideHerd User Directory (GitLab #65): store-backed users for the
-- dev-user authentication provider, managed live through the
-- Administration Framework. Credentials are held ONLY as SHA-256 digests;
-- raw credentials exist only in the moment of issuance and are never
-- stored, logged, or audited.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT,
  roles_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  credential_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_key, subject)
);

-- Login resolves a presented credential's digest to at most one user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_credential_hash
  ON users (credential_hash) WHERE credential_hash IS NOT NULL;
