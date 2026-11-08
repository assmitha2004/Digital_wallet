import crypto from 'node:crypto';
import { withRetry, withTransaction } from './db.js';
import { AppError } from './errors.js';

/** SHA-256 of the route and body, so the same key cannot be reused for a different payment. */
export function hashRequest(route, body) {
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(`${route}\n${canonical}`).digest('hex');
}

/**
 * Runs a payment at most once per (user, Idempotency-Key).
 *
 * How it works — everything happens in ONE database transaction:
 *   1. INSERT the key. The UNIQUE index does the hard part:
 *      - new key            -> the insert succeeds and we do the payment.
 *      - key already done   -> duplicate-key error, so we replay the saved response.
 *      - same key in flight -> InnoDB makes our INSERT wait until the other request
 *                              commits (then: replay) or rolls back (then: we run it).
 *   2. Run the payment and save its response on the key row.
 *   3. COMMIT. The money movement and the saved response become visible together.
 *
 * If the server crashes half-way, the transaction rolls back and the key is free again,
 * so there is no "stuck in progress" state to clean up.
 *
 * `work(conn)` must throw any 4xx AppError BEFORE it writes anything; those results are
 * saved too, so a retry gets the same answer.
 *
 * Returns { status, body, replayed }.
 */
export function runIdempotent({ userId, key, route, body }, work) {
  const requestHash = hashRequest(route, body);

  return withRetry(() =>
    withTransaction(async (conn) => {
      try {
        await conn.execute('INSERT INTO idempotency_keys (user_id, idem_key, request_hash) VALUES (?, ?, ?)', [
          userId,
          key,
          requestHash,
        ]);
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        const [rows] = await conn.execute(
          'SELECT request_hash, response_code, response_body FROM idempotency_keys WHERE user_id = ? AND idem_key = ? FOR UPDATE',
          [userId, key],
        );
        const saved = rows[0];
        if (saved.request_hash !== requestHash) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
        }
        return { status: saved.response_code, body: saved.response_body, replayed: true };
      }

      let result;
      try {
        result = { status: 201, body: await work(conn) };
      } catch (err) {
        if (!(err instanceof AppError) || err.status >= 500) throw err; // rolls back, key is freed
        result = { status: err.status, body: err.toBody() };
      }

      await conn.execute('UPDATE idempotency_keys SET response_code = ?, response_body = ? WHERE user_id = ? AND idem_key = ?', [
        result.status,
        JSON.stringify(result.body),
        userId,
        key,
      ]);
      return { ...result, replayed: false };
    }),
  );
}
