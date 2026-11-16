// Razorpay top-ups (test mode works with test keys; no real money).
//
// Flow:
//   1. POST /wallet/topups/orders      -> we create a Razorpay order and remember it (gateway_orders)
//   2. The browser opens Razorpay Checkout; the user pays.
//   3. Razorpay tells us twice, in any order:
//        a. the browser posts the signed result to /wallet/topups/orders/:id/confirm
//        b. Razorpay's server posts a signed webhook to /webhooks/razorpay
//   4. Whichever arrives first credits the wallet. The order row is locked FOR UPDATE and marked
//      PAID in the same transaction as the credit, so the second one finds PAID and does nothing.
//      transactions.external_ref (UNIQUE) is a second guard: one gateway payment, one credit.
import crypto from 'node:crypto';
import { AUDIT, recordAudit } from './audit.js';
import { config, razorpayEnabled } from './config.js';
import { pool, withTransaction } from './db.js';
import { AppError, unprocessable } from './errors.js';
import { displayInr, formatPaise } from './money.js';
import { creditFromSystem } from './payments.js';

const PROVIDER = 'RAZORPAY';

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time comparison, so response timing reveals nothing about the expected signature. */
export function safeEqualHex(expectedHex, givenHex) {
  if (typeof givenHex !== 'string' || !/^[0-9a-f]+$/i.test(givenHex)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(givenHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Signature Razorpay Checkout returns to the browser: HMAC-SHA256(order_id|payment_id, key secret). */
export const checkoutSignature = (orderId, paymentId, secret = config.razorpay.keySecret) => hmacHex(secret, `${orderId}|${paymentId}`);

/** Signature on webhooks: HMAC-SHA256 of the exact raw request body, with the webhook secret. */
export const webhookSignature = (rawBody, secret = config.razorpay.webhookSecret) => hmacHex(secret, rawBody);

function requireGateway() {
  if (!razorpayEnabled()) throw new AppError(503, 'GATEWAY_DISABLED', 'Card and UPI top-ups are not set up on this server.');
}

// The HTTP call to Razorpay is replaceable so tests can run without network access.
let createRemoteOrder = async ({ amountPaise, receipt, notes }) => {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const response = await fetch(`${config.razorpay.apiBase}/orders`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new AppError(502, 'GATEWAY_ERROR', 'The payment gateway did not accept the order. Try again.');
  return response.json();
};
export const setRemoteOrderCreator = (fn) => {
  createRemoteOrder = fn;
};

/**
 * Step 1. The call to Razorpay happens OUTSIDE any database transaction: never hold row locks
 * while waiting on the network. An order that is created but never paid is harmless (it expires),
 * so this step needs no idempotency key.
 */
export async function createOrder({ userId, amountPaise }) {
  requireGateway();
  if (amountPaise > config.limits.maxTopupPaise) {
    throw unprocessable('LIMIT_EXCEEDED', `You can add at most ${displayInr(config.limits.maxTopupPaise)} at a time.`);
  }
  const receipt = `pl_${userId}_${crypto.randomUUID().slice(0, 8)}`;
  const order = await createRemoteOrder({ amountPaise, receipt, notes: { userId: String(userId) } });
  await pool.execute('INSERT INTO gateway_orders (user_id, provider, order_id, amount_paise) VALUES (?, ?, ?, ?)', [
    userId,
    PROVIDER,
    order.id,
    amountPaise,
  ]);
  return { orderId: order.id, keyId: config.razorpay.keyId, amountPaise, currency: 'INR' };
}

/**
 * Step 4. Credits an order exactly once. Returns { credited: true|false, ... }.
 * `expectedUserId` is set for the browser path (a user may only confirm their own order).
 */
async function creditOrder({ orderId, paymentId, amountPaise, source, expectedUserId, req }) {
  return withTransaction(async (conn) => {
    const [[order]] = await conn.execute(
      'SELECT id, user_id, amount_paise, status, payment_id FROM gateway_orders WHERE provider = ? AND order_id = ? FOR UPDATE',
      [PROVIDER, orderId],
    );
    if (!order || (expectedUserId && order.user_id !== expectedUserId)) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'No such top-up.');
    }
    if (order.status === 'PAID') return { credited: false, alreadyPaid: true, userId: order.user_id };
    if (amountPaise !== undefined && amountPaise !== order.amount_paise) {
      await conn.execute("UPDATE gateway_orders SET status = 'FAILED' WHERE id = ?", [order.id]);
      await recordAudit(
        { action: AUDIT.WEBHOOK_REJECTED, targetType: 'gateway_order', targetId: orderId, req, metadata: { reason: 'amount_mismatch', amountPaise, expected: order.amount_paise } },
        conn,
      );
      return { credited: false, rejected: 'AMOUNT_MISMATCH' };
    }

    const result = await creditFromSystem(conn, {
      userId: order.user_id,
      amountPaise: order.amount_paise,
      note: 'Added money (Razorpay)',
      externalRef: paymentId,
    });
    await conn.execute("UPDATE gateway_orders SET status = 'PAID', payment_id = ?, transaction_id = ? WHERE id = ?", [
      paymentId,
      result.transactionId,
      order.id,
    ]);
    await recordAudit(
      {
        action: AUDIT.GATEWAY_TOPUP_CREDITED,
        actorUserId: order.user_id,
        targetType: 'gateway_order',
        targetId: orderId,
        req,
        metadata: { paymentId, source, amountPaise: order.amount_paise },
      },
      conn,
    );
    const { transactionId: _ignored, ...body } = result;
    return { credited: true, userId: order.user_id, ...body };
  });
}

/** Step 3a: the browser's signed result from Razorpay Checkout. */
export async function confirmFromCheckout({ userId, orderId, paymentId, signature, req }) {
  requireGateway();
  if (!safeEqualHex(checkoutSignature(orderId, paymentId), signature)) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Payment confirmation could not be verified.');
  }
  const outcome = await creditOrder({ orderId, paymentId, source: 'checkout', expectedUserId: userId, req });
  const [[wallet]] = await pool.execute('SELECT balance_paise FROM wallets WHERE user_id = ?', [userId]);
  return { status: outcome.credited ? 'CREDITED' : 'ALREADY_CREDITED', balancePaise: wallet.balance_paise, balance: formatPaise(wallet.balance_paise) };
}

/**
 * Step 3b: Razorpay's webhook. Always answer 2xx once the signature is valid (even for events we
 * ignore), otherwise Razorpay keeps retrying. An invalid signature gets 400 and an audit entry.
 */
export async function handleWebhook({ rawBody, signature, req }) {
  if (!config.razorpay.webhookSecret) throw new AppError(503, 'GATEWAY_DISABLED', 'Webhooks are not set up on this server.');
  if (!rawBody || !safeEqualHex(webhookSignature(rawBody), signature)) {
    await recordAudit({ action: AUDIT.WEBHOOK_REJECTED, targetType: 'webhook', targetId: PROVIDER, req, metadata: { reason: 'bad_signature' } });
    throw new AppError(400, 'INVALID_SIGNATURE', 'Webhook signature is not valid.');
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Webhook body is not JSON.');
  }
  if (!['payment.captured', 'order.paid'].includes(event.event)) return { handled: false, event: event.event };

  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id || !payment?.id) return { handled: false, event: event.event };
  if (payment.currency && payment.currency !== 'INR') return { handled: false, reason: 'currency' };
  try {
    const outcome = await creditOrder({ orderId: payment.order_id, paymentId: payment.id, amountPaise: payment.amount, source: 'webhook', req });
    return { handled: true, credited: outcome.credited, rejected: outcome.rejected };
  } catch (err) {
    // An order we never created (another app on the same Razorpay account): acknowledge and move on.
    if (err instanceof AppError && err.code === 'ORDER_NOT_FOUND') return { handled: false, reason: 'unknown_order' };
    throw err;
  }
}
