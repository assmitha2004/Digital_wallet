import { Router } from 'express';
import { z } from 'zod';
import { listAudit } from './audit.js';
import { config, razorpayEnabled } from './config.js';
import { pool, withTransaction } from './db.js';
import { confirmFromCheckout, createOrder } from './gateway.js';
import { runIdempotent } from './idempotency.js';
import { paymentsTotal } from './metrics.js';
import { requireAuth, requireIdempotencyKey, validateBody } from './middleware.js';
import { formatPaise, rupeesToPaise } from './money.js';
import { getWalletByUserId, listActivity, refund, topUp, transfer, verifyWallet } from './payments.js';
import { paymentLimiter } from './rateLimits.js';
import { closeRequest, createRequest, listRequests, payRequest } from './requests.js';
import { buildStatement, statementCsv, writeStatementPdf } from './statements.js';

const amountField = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const paise = rupeesToPaise(value);
    if (paise === null) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount greater than 0 with at most 2 decimal places, e.g. "250.50".' });
      return z.NEVER;
    }
    return paise;
  });
const otpField = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');
const uuidParam = z.uuid();

const topUpSchema = z.object({ amount: amountField });
const transferSchema = z.object({
  toEmail: z.email().trim().toLowerCase(),
  amount: amountField,
  note: z.string().trim().max(140).optional(),
  otp: otpField.optional(),
});
const refundSchema = z.object({ amount: amountField.optional(), reason: z.string().trim().max(120).optional() });
const requestSchema = z.object({
  fromEmail: z.email().trim().toLowerCase(),
  amount: amountField,
  note: z.string().trim().max(140).optional(),
});
const payRequestSchema = z.object({ otp: otpField.optional() });
const confirmSchema = z.object({
  razorpayPaymentId: z.string().regex(/^[A-Za-z0-9_]{6,64}$/),
  razorpaySignature: z.string().regex(/^[0-9a-f]{64}$/i),
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});
const requestsQuerySchema = z.object({
  direction: z.enum(['incoming', 'outgoing']).default('incoming'),
  status: z.enum(['PENDING', 'PAID', 'DECLINED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});
const statementQuerySchema = z.object({ from: day, to: day, format: z.enum(['csv', 'pdf', 'json']).default('csv') });

function sendResult(res, result, kind) {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  else paymentsTotal.inc({ kind, outcome: result.status < 300 ? 'success' : 'rejected' });
  res.status(result.status).json(result.body);
}

/**
 * Wraps a payment in runIdempotent. The 2FA code is left OUT of the request hash: a retry of the
 * same payment may carry a newer code, and that must still count as the same request.
 */
const idempotent = (route, req, work) => {
  const { otp: _otp, ...hashedBody } = req.body;
  return runIdempotent({ userId: req.userId, key: req.idempotencyKey, route, body: { ...hashedBody, ...req.params } }, work);
};

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get('/me', async (req, res) => {
  const [[user]] = await pool.execute('SELECT id, name, email, role, totp_enabled, created_at FROM users WHERE id = ?', [req.userId]);
  const wallet = await getWalletByUserId(pool, req.userId);
  res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, twoFactorEnabled: Boolean(user.totp_enabled), createdAt: user.created_at },
    wallet: { balancePaise: wallet.balance_paise, balance: formatPaise(wallet.balance_paise), currency: wallet.currency, status: wallet.status },
    settings: {
      stepUpThresholdPaise: config.stepUpThresholdPaise,
      maxTopupPaise: config.limits.maxTopupPaise,
      maxTransferPaise: config.limits.maxTransferPaise,
      dailyTransferPaise: config.limits.dailyTransferPaise,
      simulatedTopups: config.topups.allowSimulated,
      razorpay: razorpayEnabled() ? { keyId: config.razorpay.keyId } : null,
    },
  });
});

walletRouter.get('/me/security-events', async (req, res) => {
  res.json(await listAudit({ actorUserId: req.userId, limit: 20 }));
});

// ---- Money in ------------------------------------------------------------------------------

walletRouter.post('/wallet/topups', paymentLimiter, requireIdempotencyKey, validateBody(topUpSchema), async (req, res) => {
  const result = await idempotent('POST /wallet/topups', req, (conn) => topUp(conn, { userId: req.userId, amountPaise: req.body.amount }));
  sendResult(res, result, 'topup');
});

walletRouter.post('/wallet/topups/orders', paymentLimiter, validateBody(topUpSchema), async (req, res) => {
  res.status(201).json(await createOrder({ userId: req.userId, amountPaise: req.body.amount }));
});

walletRouter.post('/wallet/topups/orders/:orderId/confirm', validateBody(confirmSchema), async (req, res) => {
  const orderId = z.string().regex(/^[A-Za-z0-9_]{6,64}$/).parse(req.params.orderId);
  res.json(
    await confirmFromCheckout({
      userId: req.userId,
      orderId,
      paymentId: req.body.razorpayPaymentId,
      signature: req.body.razorpaySignature,
      req,
    }),
  );
});

// ---- Money out -----------------------------------------------------------------------------

walletRouter.post('/transfers', paymentLimiter, requireIdempotencyKey, validateBody(transferSchema), async (req, res) => {
  const { toEmail, amount, note, otp } = req.body;
  const result = await idempotent('POST /transfers', req, (conn) =>
    transfer(conn, { userId: req.userId, toEmail, amountPaise: amount, note, otp }),
  );
  sendResult(res, result, 'transfer');
});

walletRouter.post('/transactions/:id/refunds', paymentLimiter, requireIdempotencyKey, validateBody(refundSchema), async (req, res) => {
  const transactionPublicId = uuidParam.parse(req.params.id);
  const result = await idempotent('POST /transactions/:id/refunds', req, (conn) =>
    refund(conn, { userId: req.userId, transactionPublicId, amountPaise: req.body.amount, reason: req.body.reason, req }),
  );
  sendResult(res, result, 'refund');
});

// ---- Payment requests ----------------------------------------------------------------------

walletRouter.post('/payment-requests', requireIdempotencyKey, validateBody(requestSchema), async (req, res) => {
  const result = await idempotent('POST /payment-requests', req, (conn) =>
    createRequest(conn, { requesterUserId: req.userId, fromEmail: req.body.fromEmail, amountPaise: req.body.amount, note: req.body.note }),
  );
  sendResult(res, result, 'request');
});

walletRouter.get('/payment-requests', async (req, res) => {
  res.json(await listRequests(req.userId, requestsQuerySchema.parse(req.query)));
});

walletRouter.post('/payment-requests/:id/pay', paymentLimiter, requireIdempotencyKey, validateBody(payRequestSchema), async (req, res) => {
  const requestId = uuidParam.parse(req.params.id);
  const result = await idempotent('POST /payment-requests/:id/pay', req, (conn) =>
    payRequest(conn, { userId: req.userId, requestId, otp: req.body.otp }),
  );
  sendResult(res, result, 'request_payment');
});

for (const action of ['decline', 'cancel']) {
  walletRouter.post(`/payment-requests/:id/${action}`, async (req, res) => {
    const requestId = uuidParam.parse(req.params.id);
    res.json(await withTransaction((conn) => closeRequest(conn, { userId: req.userId, requestId, action })));
  });
}

// ---- History and statements ----------------------------------------------------------------

walletRouter.get('/wallet/activity', async (req, res) => {
  const query = activityQuerySchema.parse(req.query);
  const wallet = await getWalletByUserId(pool, req.userId);
  res.json(await listActivity(wallet.id, query));
});

walletRouter.get('/wallet/verify', async (req, res) => {
  const wallet = await getWalletByUserId(pool, req.userId);
  res.json(await verifyWallet(wallet.id));
});

walletRouter.get('/wallet/statement', async (req, res) => {
  const { from, to, format } = statementQuerySchema.parse(req.query);
  const wallet = await getWalletByUserId(pool, req.userId);
  const statement = await buildStatement(wallet.id, { from, to });
  const filename = `payledger-statement-${from}-to-${to}`;
  if (format === 'json') return res.json(statement);
  res.set('Cache-Control', 'no-store');
  if (format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(statementCsv(statement));
  }
  const [[user]] = await pool.execute('SELECT name, email FROM users WHERE id = ?', [req.userId]);
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  return writeStatementPdf(statement, user, res);
});
