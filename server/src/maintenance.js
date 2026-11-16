import { config } from './config.js';
import { pool } from './db.js';

const BATCH = 1000;

/**
 * Deletes in small batches: one huge DELETE would hold locks for a long time and block payments.
 * Returns how many rows were removed.
 */
async function deleteInBatches(sql, params) {
  let total = 0;
  for (;;) {
    const [result] = await pool.execute(`${sql} LIMIT ${BATCH}`, params);
    total += result.affectedRows;
    if (result.affectedRows < BATCH) return total;
  }
}

/**
 * Housekeeping, run daily (Vercel Cron -> POST /api/internal/cleanup, or `npm run cleanup`):
 *  - idempotency keys older than IDEMPOTENCY_KEY_TTL_HOURS (24 h). After that, a retry with the
 *    same key is treated as a new payment, the same window Stripe uses. Clients retry within
 *    seconds or minutes, so a day is generous.
 *  - refresh tokens that expired more than a day ago (kept briefly so reuse detection still works).
 */
export async function runCleanup() {
  const idempotencyKeys = await deleteInBatches(
    'DELETE FROM idempotency_keys WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)',
    [config.idempotencyKeyTtlHours],
  );
  const refreshTokens = await deleteInBatches(
    'DELETE FROM refresh_tokens WHERE expires_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY)',
    [],
  );
  return { idempotencyKeys, refreshTokens };
}
