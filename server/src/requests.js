// "Request money": one user asks another to pay. The payer can pay or decline; the requester can cancel.
import crypto from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError, unprocessable } from './errors.js';
import { formatPaise } from './money.js';
import { findRecipient, moveBetweenUsers } from './payments.js';

export async function createRequest(conn, { requesterUserId, fromEmail, amountPaise, note }) {
  if (amountPaise > config.limits.maxTransferPaise) {
    throw unprocessable('LIMIT_EXCEEDED', 'That is more than one transfer can carry.');
  }
  const payer = await findRecipient(conn, { email: fromEmail });
  if (payer.user_id === requesterUserId) throw unprocessable('SELF_REQUEST', 'You cannot request money from yourself.');

  // Stops one user from flooding another with requests.
  const [[{ open }]] = await conn.execute(
    "SELECT COUNT(*) AS open FROM payment_requests WHERE requester_user_id = ? AND status = 'PENDING'",
    [requesterUserId],
  );
  if (open >= config.limits.maxPendingRequests) {
    throw unprocessable('TOO_MANY_OPEN_REQUESTS', `You can have at most ${config.limits.maxPendingRequests} open requests.`);
  }

  const publicId = crypto.randomUUID();
  await conn.execute(
    'INSERT INTO payment_requests (public_id, requester_user_id, payer_user_id, amount_paise, note) VALUES (?, ?, ?, ?, ?)',
    [publicId, requesterUserId, payer.user_id, amountPaise, note ?? null],
  );
  return { request: { id: publicId, status: 'PENDING', amountPaise, amount: formatPaise(amountPaise), payer: { name: payer.name, email: payer.email }, note: note ?? null } };
}

/**
 * Locks the request row FOR UPDATE and checks who may act on it.
 * Locking makes "pay" and "cancel" (or two "pay" clicks) at the same moment take turns:
 * the second one sees the new status and stops.
 */
async function lockRequest(conn, publicId, userId, role) {
  const [[row]] = await conn.execute(
    'SELECT id, public_id, requester_user_id, payer_user_id, amount_paise, note, status FROM payment_requests WHERE public_id = ? FOR UPDATE',
    [publicId],
  );
  const owner = role === 'payer' ? row?.payer_user_id : row?.requester_user_id;
  if (!row || owner !== userId) throw new AppError(404, 'REQUEST_NOT_FOUND', 'No such request.');
  if (row.status !== 'PENDING') throw new AppError(409, 'REQUEST_CLOSED', `This request is already ${row.status.toLowerCase()}.`);
  return row;
}

/** The payer pays: a normal transfer (same limits, locks and 2FA step-up) plus marking the request paid. */
export async function payRequest(conn, { userId, requestId, otp }) {
  const row = await lockRequest(conn, requestId, userId, 'payer');
  const requester = await findRecipient(conn, { userId: row.requester_user_id });
  const result = await moveBetweenUsers(conn, {
    senderUserId: userId,
    recipient: requester,
    amountPaise: row.amount_paise,
    note: row.note ?? 'Payment request',
    otp,
  });
  await conn.execute("UPDATE payment_requests SET status = 'PAID', transaction_id = ? WHERE id = ?", [result.transactionId, row.id]);
  const { transactionId: _ignored, ...body } = result;
  return { ...body, request: { id: row.public_id, status: 'PAID' } };
}

export async function closeRequest(conn, { userId, requestId, action }) {
  const row = await lockRequest(conn, requestId, userId, action === 'decline' ? 'payer' : 'requester');
  const status = action === 'decline' ? 'DECLINED' : 'CANCELLED';
  await conn.execute('UPDATE payment_requests SET status = ? WHERE id = ?', [status, row.id]);
  return { request: { id: row.public_id, status } };
}

export async function listRequests(userId, { direction, status, limit = 20, cursor }) {
  const mine = direction === 'incoming' ? 'r.payer_user_id' : 'r.requester_user_id';
  const other = direction === 'incoming' ? 'r.requester_user_id' : 'r.payer_user_id';
  const params = [userId];
  let extra = '';
  if (status) {
    extra += ' AND r.status = ?';
    params.push(status);
  }
  if (cursor) {
    extra += ' AND r.id < ?';
    params.push(cursor);
  }
  const [rows] = await pool.execute(
    `SELECT r.id, r.public_id, r.amount_paise, r.note, r.status, r.created_at, r.updated_at, u.name, u.email
       FROM payment_requests r JOIN users u ON u.id = ${other}
      WHERE ${mine} = ?${extra}
      ORDER BY r.id DESC LIMIT ${Number(limit) + 1}`,
    params,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.public_id,
      amountPaise: row.amount_paise,
      amount: formatPaise(row.amount_paise),
      note: row.note,
      status: row.status,
      // incoming: the person asking you to pay; outgoing: the person you asked
      counterparty: { name: row.name, email: row.email },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    nextCursor: rows.length > limit ? page.at(-1).id : null,
  };
}
