// The core of the project: moving money safely.
import crypto from 'node:crypto';
import { AUDIT, recordAudit } from './audit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError, unprocessable } from './errors.js';
import { displayInr, formatPaise, startOfTodayIST } from './money.js';
import { consumeOtp } from './twoFactor.js';

export const SYSTEM_WALLET_ID = 1;

export async function getWalletByUserId(db, userId) {
  const [rows] = await db.execute('SELECT id, balance_paise, currency, status FROM wallets WHERE user_id = ?', [userId]);
  if (!rows[0]) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
  return rows[0];
}

/**
 * Locks wallet rows with SELECT ... FOR UPDATE, always in ascending id order.
 *
 * Why the order matters: if request 1 locks A then waits for B, while request 2 locks B
 * then waits for A, both wait forever (a deadlock). If everyone locks the lower id first,
 * that cycle cannot form.
 */
async function lockWallets(conn, ...walletIds) {
  const locked = new Map();
  for (const id of [...new Set(walletIds)].sort((a, b) => a - b)) {
    const [rows] = await conn.execute('SELECT id, kind, balance_paise, currency, status FROM wallets WHERE id = ? FOR UPDATE', [id]);
    locked.set(id, rows[0]);
  }
  return locked;
}

/** Checked on the LOCKED rows, so a wallet cannot be frozen between the check and the write. */
function assertCanMove(fromWallet, toWallet) {
  for (const wallet of [fromWallet, toWallet]) {
    if (wallet.status === 'FROZEN') {
      throw new AppError(403, 'WALLET_FROZEN', wallet === fromWallet ? 'Your wallet is frozen. Contact support.' : "The other person's wallet cannot receive money right now.");
    }
  }
  if (fromWallet.currency !== toWallet.currency) {
    throw unprocessable('CURRENCY_MISMATCH', `Cannot move ${fromWallet.currency} into a ${toWallet.currency} wallet.`);
  }
}

/**
 * Double-entry write: one DEBIT on the sender, one CREDIT on the receiver, same amount.
 * Balances are updated in the same transaction, so the cached balance always equals
 * the sum of the wallet's ledger entries.
 */
async function postTransaction(conn, { type, fromWallet, toWallet, amountPaise, note, refundOfId = null, externalRef = null }) {
  const publicId = crypto.randomUUID();
  const fromBalanceAfter = fromWallet.balance_paise - amountPaise;
  const toBalanceAfter = toWallet.balance_paise + amountPaise;

  await conn.execute('UPDATE wallets SET balance_paise = balance_paise - ? WHERE id = ?', [amountPaise, fromWallet.id]);
  await conn.execute('UPDATE wallets SET balance_paise = balance_paise + ? WHERE id = ?', [amountPaise, toWallet.id]);

  const [txResult] = await conn.execute(
    `INSERT INTO transactions (public_id, type, amount_paise, from_wallet_id, to_wallet_id, note, refund_of_id, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [publicId, type, amountPaise, fromWallet.id, toWallet.id, note ?? null, refundOfId, externalRef],
  );
  await conn.execute(
    `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount_paise, balance_after_paise)
     VALUES (?, ?, 'DEBIT', ?, ?), (?, ?, 'CREDIT', ?, ?)`,
    [txResult.insertId, fromWallet.id, amountPaise, fromBalanceAfter, txResult.insertId, toWallet.id, amountPaise, toBalanceAfter],
  );

  return { id: txResult.insertId, publicId, fromBalanceAfter, toBalanceAfter };
}

/**
 * Credits a user's wallet from the SYSTEM wallet (where money enters the platform).
 * Used by the simulated gateway and by real gateway top-ups. Runs inside the caller's transaction.
 */
export async function creditFromSystem(conn, { userId, amountPaise, note = 'Added money', externalRef = null }) {
  const wallet = await getWalletByUserId(conn, userId);
  const locked = await lockWallets(conn, SYSTEM_WALLET_ID, wallet.id);
  const toWallet = locked.get(wallet.id);
  if (toWallet.status === 'FROZEN') throw new AppError(403, 'WALLET_FROZEN', 'Your wallet is frozen. Contact support.');
  const result = await postTransaction(conn, {
    type: 'TOPUP',
    fromWallet: locked.get(SYSTEM_WALLET_ID),
    toWallet,
    amountPaise,
    note,
    externalRef,
  });
  return {
    transactionId: result.id,
    transaction: { id: result.publicId, type: 'TOPUP', amountPaise, amount: formatPaise(amountPaise) },
    balancePaise: result.toBalanceAfter,
    balance: formatPaise(result.toBalanceAfter),
  };
}

/** Add money from the simulated payment gateway. Runs inside runIdempotent's transaction. */
export async function topUp(conn, { userId, amountPaise }) {
  if (!config.topups.allowSimulated) {
    throw new AppError(403, 'SIMULATED_TOPUPS_OFF', 'Add money through the payment gateway.');
  }
  if (amountPaise > config.limits.maxTopupPaise) {
    throw unprocessable('LIMIT_EXCEEDED', `You can add at most ${displayInr(config.limits.maxTopupPaise)} at a time.`);
  }
  const { transactionId: _ignored, ...result } = await creditFromSystem(conn, { userId, amountPaise });
  return result;
}

/**
 * Large transfers need a code from the user's authenticator app ("step-up" authentication),
 * so a stolen session alone cannot empty a wallet. Checked before any money moves.
 */
async function checkStepUp(conn, { userId, amountPaise, otp }) {
  if (amountPaise < config.stepUpThresholdPaise) return;
  const [[user]] = await conn.execute('SELECT totp_enabled, totp_secret FROM users WHERE id = ?', [userId]);
  const threshold = displayInr(config.stepUpThresholdPaise);
  if (!user.totp_enabled) {
    throw new AppError(403, 'TWO_FACTOR_REQUIRED', `Turn on two-step verification to send ${threshold} or more.`);
  }
  if (!otp) throw new AppError(403, 'OTP_REQUIRED', `Payments of ${threshold} or more need the code from your authenticator app.`);
  await consumeOtp(conn, userId, otp, { secret: user.totp_secret });
}

/**
 * Moves money between two users. Shared by transfers and paid payment requests.
 * Every check runs on the locked rows (see lockWallets).
 */
async function moveBetweenUsers(conn, { senderUserId, recipient, amountPaise, note, otp }) {
  if (amountPaise > config.limits.maxTransferPaise) {
    throw unprocessable('LIMIT_EXCEEDED', `You can send at most ${displayInr(config.limits.maxTransferPaise)} in one transfer.`);
  }
  if (recipient.user_id === senderUserId) throw unprocessable('SELF_TRANSFER', 'You cannot send money to yourself.');
  await checkStepUp(conn, { userId: senderUserId, amountPaise, otp });

  const sender = await getWalletByUserId(conn, senderUserId);
  const locked = await lockWallets(conn, sender.id, recipient.wallet_id);
  const fromWallet = locked.get(sender.id);
  const toWallet = locked.get(recipient.wallet_id);
  assertCanMove(fromWallet, toWallet);

  // These checks read the balance AFTER we hold the lock, so no other transfer can change
  // it between the check and the write. Checking before locking would allow double-spending.
  if (fromWallet.balance_paise < amountPaise) {
    throw unprocessable('INSUFFICIENT_FUNDS', `Your balance is ${displayInr(fromWallet.balance_paise)}.`);
  }
  const [[{ sentToday }]] = await conn.execute(
    "SELECT COALESCE(SUM(amount_paise), 0) AS sentToday FROM transactions WHERE from_wallet_id = ? AND type = 'TRANSFER' AND created_at >= ?",
    [sender.id, startOfTodayIST()],
  );
  if (sentToday + amountPaise > config.limits.dailyTransferPaise) {
    throw unprocessable(
      'DAILY_LIMIT_EXCEEDED',
      `Daily limit is ${displayInr(config.limits.dailyTransferPaise)}. You can send ${displayInr(
        config.limits.dailyTransferPaise - sentToday,
      )} more today.`,
    );
  }

  const result = await postTransaction(conn, { type: 'TRANSFER', fromWallet, toWallet, amountPaise, note });
  return {
    transactionId: result.id,
    transaction: {
      id: result.publicId,
      type: 'TRANSFER',
      amountPaise,
      amount: formatPaise(amountPaise),
      to: { name: recipient.name, email: recipient.email },
      note: note ?? null,
    },
    balancePaise: result.fromBalanceAfter,
    balance: formatPaise(result.fromBalanceAfter),
  };
}

export async function findRecipient(conn, { email, userId }) {
  const [rows] = await conn.execute(
    `SELECT u.id AS user_id, u.name, u.email, w.id AS wallet_id
       FROM users u JOIN wallets w ON w.user_id = u.id WHERE ${email ? 'u.email = ?' : 'u.id = ?'}`,
    [email ?? userId],
  );
  if (!rows[0]) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'No PayLedger account uses that email.');
  return rows[0];
}

/** Send money to another user by email. Runs inside runIdempotent's transaction. */
export async function transfer(conn, { userId, toEmail, amountPaise, note, otp }) {
  const recipient = await findRecipient(conn, { email: toEmail });
  const { transactionId: _ignored, ...result } = await moveBetweenUsers(conn, { senderUserId: userId, recipient, amountPaise, note, otp });
  return result;
}

export { moveBetweenUsers };

/**
 * Refund (all or part of) a transfer you RECEIVED. The money goes back to the original sender as
 * a new REFUND transaction linked to the original; the original is never edited.
 *
 * Concurrency: the original transaction row is locked first (FOR UPDATE), so two refunds of the
 * same payment run one after the other and cannot together refund more than was paid. Wallets are
 * then locked in id order as usual. Every refund path takes locks in the same order
 * (transaction row -> wallets), so no deadlock cycle can form.
 */
export async function refund(conn, { userId, transactionPublicId, amountPaise, reason, req }) {
  // Lock ONLY the transaction row here. (A FOR UPDATE on a join would also lock the wallet row,
  // out of id order, and could deadlock with a transfer.)
  const [[original]] = await conn.execute(
    'SELECT id, public_id, type, amount_paise, from_wallet_id, to_wallet_id FROM transactions WHERE public_id = ? FOR UPDATE',
    [transactionPublicId],
  );
  const myWallet = await getWalletByUserId(conn, userId);
  // Same answer for "does not exist" and "not yours", so ids of other people's payments leak nothing.
  if (!original || original.to_wallet_id !== myWallet.id) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'No such payment to you.');
  if (original.type !== 'TRANSFER') throw unprocessable('NOT_REFUNDABLE', 'Only payments you received can be refunded.');

  const [[{ refunded }]] = await conn.execute(
    "SELECT COALESCE(SUM(amount_paise), 0) AS refunded FROM transactions WHERE refund_of_id = ? AND type = 'REFUND'",
    [original.id],
  );
  const refundable = original.amount_paise - refunded;
  const amount = amountPaise ?? refundable;
  if (refundable <= 0) throw unprocessable('ALREADY_REFUNDED', 'This payment has already been fully refunded.');
  if (amount > refundable) throw unprocessable('REFUND_TOO_LARGE', `You can refund at most ${displayInr(refundable)} of this payment.`);

  const locked = await lockWallets(conn, original.to_wallet_id, original.from_wallet_id);
  const fromWallet = locked.get(original.to_wallet_id);
  const toWallet = locked.get(original.from_wallet_id);
  assertCanMove(fromWallet, toWallet);
  if (fromWallet.balance_paise < amount) {
    throw unprocessable('INSUFFICIENT_FUNDS', `Your balance is ${displayInr(fromWallet.balance_paise)}.`);
  }

  const result = await postTransaction(conn, {
    type: 'REFUND',
    fromWallet,
    toWallet,
    amountPaise: amount,
    note: reason ? `Refund: ${reason}`.slice(0, 140) : 'Refund',
    refundOfId: original.id,
  });
  await recordAudit(
    {
      action: AUDIT.REFUND_ISSUED,
      actorUserId: userId,
      targetType: 'transaction',
      targetId: original.public_id,
      req,
      metadata: { refundId: result.publicId, amountPaise: amount },
    },
    conn,
  );
  return {
    transaction: { id: result.publicId, type: 'REFUND', amountPaise: amount, amount: formatPaise(amount), refundOf: original.public_id },
    refundableAfterPaise: refundable - amount,
    balancePaise: result.fromBalanceAfter,
    balance: formatPaise(result.fromBalanceAfter),
  };
}

/** Newest-first history for one wallet, using cursor pagination on the ledger entry id. */
export async function listActivity(walletId, { limit, cursor }) {
  const params = [walletId];
  let cursorClause = '';
  if (cursor) {
    cursorClause = 'AND le.id < ?';
    params.push(cursor);
  }
  // LIMIT is inlined as a validated integer (mysql2 prepared statements reject it as a parameter).
  const [rows] = await pool.execute(
    `SELECT le.id AS entry_id, le.direction, le.amount_paise, le.balance_after_paise, le.created_at,
            t.id AS tx_id, t.public_id, t.type, t.note, orig.public_id AS refund_of_public_id,
            cu.name AS counterparty_name, cu.email AS counterparty_email,
            (SELECT COALESCE(SUM(r.amount_paise), 0) FROM transactions r WHERE r.refund_of_id = t.id AND r.type = 'REFUND') AS refunded_paise
       FROM ledger_entries le
       JOIN transactions t ON t.id = le.transaction_id
       LEFT JOIN transactions orig ON orig.id = t.refund_of_id
       JOIN wallets cw ON cw.id = IF(le.direction = 'DEBIT', t.to_wallet_id, t.from_wallet_id)
       LEFT JOIN users cu ON cu.id = cw.user_id
      WHERE le.wallet_id = ? ${cursorClause}
      ORDER BY le.id DESC
      LIMIT ${limit + 1}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.public_id,
      type: row.type,
      direction: row.direction,
      amountPaise: row.amount_paise,
      amount: formatPaise(row.amount_paise),
      balanceAfterPaise: row.balance_after_paise,
      counterparty: row.counterparty_email ? { name: row.counterparty_name, email: row.counterparty_email } : null,
      note: row.note,
      refundOf: row.refund_of_public_id ?? null,
      refundedPaise: row.type === 'TRANSFER' ? row.refunded_paise : 0,
      // Only the person who RECEIVED a transfer can refund it.
      refundablePaise: row.type === 'TRANSFER' && row.direction === 'CREDIT' ? row.amount_paise - row.refunded_paise : 0,
      createdAt: row.created_at,
    })),
    nextCursor: hasMore ? page[page.length - 1].entry_id : null,
  };
}

/** Checks one wallet: cached balance must equal credits minus debits in the ledger. */
export async function verifyWallet(walletId) {
  const [[row]] = await pool.execute(
    `SELECT w.balance_paise,
            COALESCE(SUM(CASE le.direction WHEN 'CREDIT' THEN le.amount_paise ELSE -le.amount_paise END), 0) AS ledger_paise,
            COUNT(le.id) AS entries
       FROM wallets w LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`,
    [walletId],
  );
  return {
    balancePaise: row.balance_paise,
    ledgerPaise: row.ledger_paise,
    entries: row.entries,
    matches: row.balance_paise === row.ledger_paise,
  };
}

/** Whole-system audit used by tests, admins and `npm run reconcile`. Every check should return 0 problems. */
export async function reconcileAll(db = pool) {
  const [walletMismatches] = await db.query(
    `SELECT w.id, w.balance_paise,
            COALESCE(SUM(CASE le.direction WHEN 'CREDIT' THEN le.amount_paise ELSE -le.amount_paise END), 0) AS ledger_paise
       FROM wallets w LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      GROUP BY w.id HAVING w.balance_paise <> ledger_paise`,
  );
  const [unbalancedTransactions] = await db.query(
    `SELECT t.id FROM transactions t JOIN ledger_entries le ON le.transaction_id = t.id
      GROUP BY t.id, t.amount_paise
     HAVING COUNT(*) <> 2
         OR SUM(CASE le.direction WHEN 'DEBIT' THEN le.amount_paise ELSE 0 END) <> t.amount_paise
         OR SUM(CASE le.direction WHEN 'CREDIT' THEN le.amount_paise ELSE 0 END) <> t.amount_paise`,
  );
  const [overRefunded] = await db.query(
    `SELECT o.id FROM transactions o JOIN transactions r ON r.refund_of_id = o.id AND r.type = 'REFUND'
      GROUP BY o.id, o.amount_paise HAVING SUM(r.amount_paise) > o.amount_paise`,
  );
  const [[{ total }]] = await db.query('SELECT COALESCE(SUM(balance_paise), 0) AS total FROM wallets');
  const [[{ negative }]] = await db.query("SELECT COUNT(*) AS negative FROM wallets WHERE kind = 'USER' AND balance_paise < 0");
  return {
    ok: walletMismatches.length === 0 && unbalancedTransactions.length === 0 && overRefunded.length === 0 && total === 0 && negative === 0,
    walletMismatches,
    unbalancedTransactions,
    overRefundedTransactions: overRefunded,
    totalOfAllBalancesPaise: total, // money only moves between wallets, so this is always 0
    negativeUserWallets: negative,
  };
}
