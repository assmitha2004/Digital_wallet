-- Security: roles, login lockout, two-factor auth, "log out everywhere", rotating refresh tokens, audit log.
-- Every change is additive with a default, so code from before this migration keeps working.
-- One change per statement: DDL is not transactional, and the migrator treats "already exists"
-- errors as done, so a half-applied file can simply be run again.

ALTER TABLE users ADD COLUMN role ENUM('USER','ADMIN') NOT NULL DEFAULT 'USER';
ALTER TABLE users ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TIMESTAMP(3) NULL;
-- Bumped by "log out everywhere"; access tokens carry it and are rejected once it changes.
ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0;
-- Base32 TOTP secret (RFC 6238). Set at setup, used only once totp_enabled = 1.
ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL;
ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0;
-- Last 30-second step a code was accepted for, so one code cannot be used twice.
ALTER TABLE users ADD COLUMN totp_last_step BIGINT NULL;

-- Refresh tokens are random strings sent in an httpOnly cookie; only their SHA-256 is stored.
-- Each login starts a "family". Every refresh revokes the old token and issues a new one in the
-- same family. If a revoked token is used again, someone copied it, so the whole family is revoked.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  family_id    CHAR(36) NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  expires_at   TIMESTAMP(3) NOT NULL,
  revoked_at   TIMESTAMP(3) NULL,
  replaced_by  BIGINT UNSIGNED NULL,
  user_agent   VARCHAR(255) NULL,
  ip           VARCHAR(45) NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id, revoked_at),
  KEY idx_refresh_family (family_id),
  KEY idx_refresh_expires (expires_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- Append-only record of security and admin events (who, what, when, from where).
CREATE TABLE IF NOT EXISTS audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id  BIGINT UNSIGNED NULL,
  action         VARCHAR(64) NOT NULL,
  target_type    VARCHAR(32) NULL,
  target_id      VARCHAR(64) NULL,
  ip             VARCHAR(45) NULL,
  request_id     VARCHAR(64) NULL,
  metadata       JSON NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_actor (actor_user_id, id),
  KEY idx_audit_action (action, id),
  KEY idx_audit_target (target_type, target_id, id)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- Expiring old idempotency keys needs to find them by age.
CREATE INDEX idx_idem_created ON idempotency_keys (created_at);
