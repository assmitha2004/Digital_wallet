import { Router } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { runIdempotent } from './idempotency.js';
import { requireAuth, requireIdempotencyKey, validateBody } from './middleware.js';
import { formatPaise, rupeesToPaise } from './money.js';
import { getWalletByUserId, listActivity, topUp, transfer, verifyWallet } from './payments.js';

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

const topUpSchema = z.object({ amount: amountField });

const transferSchema = z.object({
  toEmail: z.email().trim().toLowerCase(),
  amount: amountField,
  note: z.string().trim().max(140).optional(),
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});

function sendResult(res, result) {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get('/me', async (req, res) => {
  const [[user]] = await pool.execute('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.userId]);
  const wallet = await getWalletByUserId(pool, req.userId);
  res.json({
    user: { id: user.id, name: user.name, email: user.email, createdAt: user.created_at },
    wallet: { balancePaise: wallet.balance_paise, balance: formatPaise(wallet.balance_paise), currency: 'INR' },
  });
});

walletRouter.post('/wallet/topups', requireIdempotencyKey, validateBody(topUpSchema), async (req, res) => {
  const result = await runIdempotent(
    { userId: req.userId, key: req.idempotencyKey, route: 'POST /wallet/topups', body: req.body },
    (conn) => topUp(conn, { userId: req.userId, amountPaise: req.body.amount }),
  );
  sendResult(res, result);
});

walletRouter.post('/transfers', requireIdempotencyKey, validateBody(transferSchema), async (req, res) => {
  const result = await runIdempotent(
    { userId: req.userId, key: req.idempotencyKey, route: 'POST /transfers', body: req.body },
    (conn) =>
      transfer(conn, { userId: req.userId, toEmail: req.body.toEmail, amountPaise: req.body.amount, note: req.body.note }),
  );
  sendResult(res, result);
});

walletRouter.get('/wallet/activity', async (req, res) => {
  const query = activityQuerySchema.parse(req.query);
  const wallet = await getWalletByUserId(pool, req.userId);
  res.json(await listActivity(wallet.id, query));
});

walletRouter.get('/wallet/verify', async (req, res) => {
  const wallet = await getWalletByUserId(pool, req.userId);
  res.json(await verifyWallet(wallet.id));
});
