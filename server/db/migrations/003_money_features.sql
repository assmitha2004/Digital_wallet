-- Money features: frozen wallets, refunds, payment requests, payment-gateway top-ups.
-- Additive only: older code keeps working against this schema.

-- An admin can freeze a wallet: no money may move into or out of it.
ALTER TABLE wallets ADD COLUMN status ENUM('ACTIVE','FROZEN') NOT NULL DEFAULT 'ACTIVE';

-- A refund is a new transaction going the other way; it never edits the original.
ALTER TABLE transactions MODIFY COLUMN type ENUM('TOPUP','TRANSFER','REFUND') NOT NULL;
ALTER TABLE transactions ADD COLUMN refund_of_id BIGINT UNSIGNED NULL;
ALTER TABLE transactions ADD CONSTRAINT fk_tx_refund_of FOREIGN KEY (refund_of_id) REFERENCES transactions(id);
CREATE INDEX idx_transactions_refund_of ON transactions (refund_of_id);
-- The payment-gateway id for gateway top-ups. UNIQUE: one gateway payment can credit a wallet once.
ALTER TABLE transactions ADD COLUMN external_ref VARCHAR(64) NULL;
CREATE UNIQUE INDEX uq_transactions_external_ref ON transactions (external_ref);

-- "Please pay me": created by the requester, paid (or declined) by the payer.
CREATE TABLE IF NOT EXISTS payment_requests (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id          CHAR(36) NOT NULL,
  requester_user_id  BIGINT UNSIGNED NOT NULL,
  payer_user_id      BIGINT UNSIGNED NOT NULL,
  amount_paise       BIGINT NOT NULL,
  note               VARCHAR(140) NULL,
  status             ENUM('PENDING','PAID','DECLINED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  transaction_id     BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_payreq_public (public_id),
  KEY idx_payreq_payer (payer_user_id, status, id),
  KEY idx_payreq_requester (requester_user_id, status, id),
  CONSTRAINT fk_payreq_requester FOREIGN KEY (requester_user_id) REFERENCES users(id),
  CONSTRAINT fk_payreq_payer FOREIGN KEY (payer_user_id) REFERENCES users(id),
  CONSTRAINT fk_payreq_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  CONSTRAINT chk_payreq_amount CHECK (amount_paise > 0),
  CONSTRAINT chk_payreq_people CHECK (requester_user_id <> payer_user_id)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- A top-up started with the payment gateway. Credited exactly once, by whichever arrives first:
-- the browser's signed confirmation or the gateway's signed webhook.
CREATE TABLE IF NOT EXISTS gateway_orders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  provider        VARCHAR(16) NOT NULL,
  order_id        VARCHAR(64) NOT NULL,
  amount_paise    BIGINT NOT NULL,
  status          ENUM('CREATED','PAID','FAILED') NOT NULL DEFAULT 'CREATED',
  payment_id      VARCHAR(64) NULL,
  transaction_id  BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_gateway_order (provider, order_id),
  UNIQUE KEY uq_gateway_payment (provider, payment_id),
  KEY idx_gateway_user (user_id, id),
  CONSTRAINT fk_gateway_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_gateway_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  CONSTRAINT chk_gateway_amount CHECK (amount_paise > 0)
) ENGINE=InnoDB /*T![auto_id_cache] AUTO_ID_CACHE=1 */;
