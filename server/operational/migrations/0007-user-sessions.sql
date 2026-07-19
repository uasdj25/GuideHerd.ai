-- Durable login sessions (ADR-0013 / GitLab #64): the session-store
-- contract (create/get/delete/size, hash-keyed, lazy expiry) on
-- PostgreSQL, so a restart no longer signs users out and sessions work
-- across instances. Rows hold the SHA-256 token hash and the validated
-- identity claim — never a raw token (a leak reveals nothing replayable).
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash    TEXT PRIMARY KEY,
  identity_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL
);

-- Login-time purge of expired rows scans by expiry.
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires
  ON user_sessions (expires_at_ms);
