import { Router } from 'express';
import { z } from 'zod';
import { AUDIT, listAudit, recordAudit } from './audit.js';
import { pool, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { requireAuth, requireRole, validateBody } from './middleware.js';
import { formatPaise } from './money.js';
import { reconcileAll } from './payments.js';

// Back-office endpoints. Every route needs an ADMIN, and every change is written to the audit log.
export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ADMIN'));

const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.coerce.number().int().positive().optional(),
});

adminRouter.get('/users', async (req, res) => {
  const { q, limit, cursor } = usersQuery.parse(req.query);
  const where = [];
  const params = [];
  if (q) {
    where.push('(u.email LIKE ? OR u.name LIKE ?)');
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (cursor) {
    where.push('u.id < ?');
    params.push(cursor);
  }
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.role, u.totp_enabled, u.created_at,
            u.locked_until > CURRENT_TIMESTAMP(3) AS locked, w.balance_paise, w.status AS wallet_status
       FROM users u JOIN wallets w ON w.user_id = u.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.id DESC LIMIT ${limit + 1}`,
    params,
  );
  const page = rows.slice(0, limit);
  res.json({
    items: page.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      twoFactorEnabled: Boolean(row.totp_enabled),
      locked: Boolean(row.locked),
      wallet: { balancePaise: row.balance_paise, balance: formatPaise(row.balance_paise), status: row.wallet_status },
      createdAt: row.created_at,
    })),
    nextCursor: rows.length > limit ? page.at(-1).id : null,
  });
});

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(200) });

for (const [action, status, auditAction] of [
  ['freeze', 'FROZEN', AUDIT.WALLET_FROZEN],
  ['unfreeze', 'ACTIVE', AUDIT.WALLET_UNFROZEN],
]) {
  adminRouter.post(`/users/:id/${action}`, validateBody(reasonSchema), async (req, res) => {
    const userId = z.coerce.number().int().positive().parse(req.params.id);
    if (userId === req.userId) throw new AppError(422, 'CANNOT_FREEZE_SELF', 'You cannot change your own wallet status.');
    await withTransaction(async (conn) => {
      // Locks the wallet row, so the change waits for any payment that is using this wallet right now.
      const [[wallet]] = await conn.execute("SELECT id, status FROM wallets WHERE user_id = ? AND kind = 'USER' FOR UPDATE", [userId]);
      if (!wallet) throw new AppError(404, 'USER_NOT_FOUND', 'No such user.');
      await conn.execute('UPDATE wallets SET status = ? WHERE id = ?', [status, wallet.id]);
      await recordAudit(
        { action: auditAction, actorUserId: req.userId, targetType: 'user', targetId: userId, req, metadata: { reason: req.body.reason, previous: wallet.status } },
        conn,
      );
    });
    res.json({ userId, walletStatus: status });
  });
}

const auditQuery = z.object({
  action: z.string().regex(/^[A-Z_]{3,64}$/).optional(),
  userId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

adminRouter.get('/audit-logs', async (req, res) => {
  const { action, userId, limit, cursor } = auditQuery.parse(req.query);
  res.json(await listAudit({ action, actorUserId: userId, limit, cursor }));
});

/** Runs the full-ledger reconciliation on demand. */
adminRouter.get('/reconcile', async (_req, res) => {
  res.json(await reconcileAll());
});
