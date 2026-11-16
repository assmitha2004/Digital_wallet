-- PayLedger schema (MySQL 8.0.16+, InnoDB).
-- All money is stored as BIGINT paise (1 rupee = 100 paise). Never FLOAT/DOUBLE.

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(80)  NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- One wallet per user, plus one SYSTEM wallet that money enters the platform from
-- (top-ups are debited from it). Only the SYSTEM wallet may go negative.
CREATE TABLE IF NOT EXISTS wallets (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NULL,
  kind          ENUM('USER','SYSTEM') NOT NULL DEFAULT 'USER',
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  balance_paise BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wallets_user (user_id),
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users(id),
  -- Last line of defence: a user wallet can never be overdrawn, even if app code has a bug.
  CONSTRAINT chk_wallet_non_negative CHECK (kind = 'SYSTEM' OR balance_paise >= 0)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- One row per money movement (a top-up or a transfer).
CREATE TABLE IF NOT EXISTS transactions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id      CHAR(36) NOT NULL,                  -- UUID shown to clients; internal ids stay private
  type           ENUM('TOPUP','TRANSFER') NOT NULL,
  amount_paise   BIGINT NOT NULL,
  from_wallet_id BIGINT UNSIGNED NOT NULL,
  to_wallet_id   BIGINT UNSIGNED NOT NULL,
  note           VARCHAR(140) NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_transactions_public (public_id),
  KEY idx_transactions_from_day (from_wallet_id, type, created_at),  -- daily limit query
  CONSTRAINT fk_tx_from FOREIGN KEY (from_wallet_id) REFERENCES wallets(id),
  CONSTRAINT fk_tx_to   FOREIGN KEY (to_wallet_id)   REFERENCES wallets(id),
  CONSTRAINT chk_tx_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT chk_tx_different_wallets CHECK (from_wallet_id <> to_wallet_id)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- Double-entry ledger: every transaction writes exactly one DEBIT and one CREDIT
-- of the same amount, so money is never created or destroyed. Rows are append-only.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_id      BIGINT UNSIGNED NOT NULL,
  wallet_id           BIGINT UNSIGNED NOT NULL,
  direction           ENUM('DEBIT','CREDIT') NOT NULL,
  amount_paise        BIGINT NOT NULL,
  balance_after_paise BIGINT NOT NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ledger_wallet_id (wallet_id, id),           -- history + cursor pagination
  KEY idx_ledger_transaction (transaction_id),
  CONSTRAINT fk_ledger_tx     FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id)      REFERENCES wallets(id),
  CONSTRAINT chk_ledger_amount_positive CHECK (amount_paise > 0)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- Idempotency: the client sends an Idempotency-Key header with every payment.
-- The UNIQUE key is what makes a retried request run at most once.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  idem_key      VARCHAR(64) NOT NULL,
  request_hash  CHAR(64) NOT NULL,      -- SHA-256 of route + body; same key + different body = rejected
  response_code SMALLINT NULL,
  response_body JSON NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_idem_user_key (user_id, idem_key),
  CONSTRAINT fk_idem_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- The platform's funding wallet (always id 1).
INSERT IGNORE INTO wallets (id, user_id, kind, balance_paise) VALUES (1, NULL, 'SYSTEM', 0);
