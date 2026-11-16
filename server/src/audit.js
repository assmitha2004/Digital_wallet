import { pool } from './db.js';

/**
 * Append-only audit trail for security and admin events.
 *
 * Pass the transaction's connection when the event belongs to a money movement or a state change,
 * so the audit row commits (or rolls back) together with it. Pass nothing to write on its own.
 */
export async function recordAudit({ action, actorUserId = null, targetType = null, targetId = null, req = null, metadata = null }, db = pool) {
  await db.execute(
    'INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, ip, request_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      actorUserId,
      action,
      targetType,
      targetId === null ? null : String(targetId),
      req?.ip ?? null,
      req?.id ? String(req.id) : null,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

export const AUDIT = Object.freeze({
  USER_REGISTERED: 'USER_REGISTERED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  TWO_FACTOR_ENABLED: 'TWO_FACTOR_ENABLED',
  TWO_FACTOR_DISABLED: 'TWO_FACTOR_DISABLED',
  REFUND_ISSUED: 'REFUND_ISSUED',
  WALLET_FROZEN: 'WALLET_FROZEN',
  WALLET_UNFROZEN: 'WALLET_UNFROZEN',
  GATEWAY_TOPUP_CREDITED: 'GATEWAY_TOPUP_CREDITED',
  WEBHOOK_REJECTED: 'WEBHOOK_REJECTED',
});

/** Newest-first audit rows, cursor-paginated on id. */
export async function listAudit({ actorUserId, action, limit = 50, cursor } = {}) {
  const where = [];
  const params = [];
  if (actorUserId) {
    where.push('(a.actor_user_id = ? OR (a.target_type = ? AND a.target_id = ?))');
    params.push(actorUserId, 'user', String(actorUserId));
  }
  if (action) {
    where.push('a.action = ?');
    params.push(action);
  }
  if (cursor) {
    where.push('a.id < ?');
    params.push(cursor);
  }
  const [rows] = await pool.execute(
    `SELECT a.id, a.action, a.actor_user_id, u.email AS actor_email, a.target_type, a.target_id, a.ip, a.request_id, a.metadata, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT ${Number(limit) + 1}`,
    params,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor_user_id ? { id: row.actor_user_id, email: row.actor_email } : null,
      target: row.target_type ? { type: row.target_type, id: row.target_id } : null,
      ip: row.ip,
      requestId: row.request_id,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
    })),
    nextCursor: rows.length > limit ? page.at(-1).id : null,
  };
}
