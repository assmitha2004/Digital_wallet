// The core of the project: moving money safely.
import crypto from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError, unprocessable } from './errors.js';
import { displayInr, formatPaise, startOfTodayIST } from './money.js';

export const SYSTEM_WALLET_ID = 1;

export async function getWalletByUserId(db, userId) {
  const [rows] = await db.execute('SELECT id, balance_paise FROM wallets WHERE user_id = ?', [userId]);
  if (!rows[0]) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
  return rows[0];
}

/**
 * Locks both wallet rows with SELECT ... FOR UPDATE, always in ascending id order.
 *
 * Why the order matters: if request 1 locks A then waits for B, while request 2 locks B
 * then waits for A, both wait forever (a deadlock). If everyone locks the lower id first,
 * that cycle cannot form.
 */
async function lockWallets(conn, walletIdA, walletIdB) {
  const locked = new Map();
  for (const id of [walletIdA, walletIdB].sort((a, b) => a - b)) {
    const [rows] = await conn.execute('SELECT id, kind, balance_paise FROM wallets WHERE id = ? FOR UPDATE', [id]);
    locked.set(id, rows[0]);
  }
  return locked;
}

/**
 * Double-entry write: one DEBIT on the sender, one CREDIT on the receiver, same amount.
 * Balances are updated in the same transaction, so the cached balance always equals
 * the sum of the wallet's ledger entries.
 */
async function postTransaction(conn, { type, fromWallet, toWallet, amountPaise, note }) {
  const publicId = crypto.randomUUID();
  const fromBalanceAfter = fromWallet.balance_paise - amountPaise;
  const toBalanceAfter = toWallet.balance_paise + amountPaise;

  await conn.execute('UPDATE wallets SET balance_paise = balance_paise - ? WHERE id = ?', [amountPaise, fromWallet.id]);
  await conn.execute('UPDATE wallets SET balance_paise = balance_paise + ? WHERE id = ?', [amountPaise, toWallet.id]);

  const [txResult] = await conn.execute(
    'INSERT INTO transactions (public_id, type, amount_paise, from_wallet_id, to_wallet_id, note) VALUES (?, ?, ?, ?, ?, ?)',
    [publicId, type, amountPaise, fromWallet.id, toWallet.id, note ?? null],
  );
  await conn.execute(
    `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount_paise, balance_after_paise)
     VALUES (?, ?, 'DEBIT', ?, ?), (?, ?, 'CREDIT', ?, ?)`,
    [txResult.insertId, fromWallet.id, amountPaise, fromBalanceAfter, txResult.insertId, toWallet.id, amountPaise, toBalanceAfter],
  );

  return { publicId, fromBalanceAfter, toBalanceAfter };
}

/** Add money from the (simulated) payment gateway. Runs inside runIdempotent's transaction. */
export async function topUp(conn, { userId, amountPaise }) {
  if (amountPaise > config.limits.maxTopupPaise) {
    throw unprocessable('LIMIT_EXCEEDED', `You can add at most ${displayInr(config.limits.maxTopupPaise)} at a time.`);
  }
  const wallet = await getWalletByUserId(conn, userId);
  const locked = await lockWallets(conn, SYSTEM_WALLET_ID, wallet.id);
  const result = await postTransaction(conn, {
    type: 'TOPUP',
    fromWallet: locked.get(SYSTEM_WALLET_ID),
    toWallet: locked.get(wallet.id),
    amountPaise,
    note: 'Added money',
  });
  return {
    transaction: { id: result.publicId, type: 'TOPUP', amountPaise, amount: formatPaise(amountPaise) },
    balancePaise: result.toBalanceAfter,
    balance: formatPaise(result.toBalanceAfter),
  };
}

/** Send money to another user by email. Runs inside runIdempotent's transaction. */
export async function transfer(conn, { userId, toEmail, amountPaise, note }) {
  if (amountPaise > config.limits.maxTransferPaise) {
    throw unprocessable('LIMIT_EXCEEDED', `You can send at most ${displayInr(config.limits.maxTransferPaise)} in one transfer.`);
  }

  const [recipients] = await conn.execute(
    'SELECT u.id AS user_id, u.name, u.email, w.id AS wallet_id FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.email = ?',
    [toEmail],
  );
  const recipient = recipients[0];
  if (!recipient) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'No PayLedger account uses that email.');
  if (recipient.user_id === userId) throw unprocessable('SELF_TRANSFER', 'You cannot send money to yourself.');

  const sender = await getWalletByUserId(conn, userId);
  const locked = await lockWallets(conn, sender.id, recipient.wallet_id);
  const fromWallet = locked.get(sender.id);

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

  const result = await postTransaction(conn, {
    type: 'TRANSFER',
    fromWallet,
    toWallet: locked.get(recipient.wallet_id),
    amountPaise,
    note,
  });
  return {
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
            t.public_id, t.type, t.note,
            cu.name AS counterparty_name, cu.email AS counterparty_email
       FROM ledger_entries le
       JOIN transactions t ON t.id = le.transaction_id
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

/** Whole-system audit used by tests and `npm run reconcile`. Every check should return 0 problems. */
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
  const [[{ total }]] = await db.query('SELECT COALESCE(SUM(balance_paise), 0) AS total FROM wallets');
  const [[{ negative }]] = await db.query("SELECT COUNT(*) AS negative FROM wallets WHERE kind = 'USER' AND balance_paise < 0");
  return {
    ok: walletMismatches.length === 0 && unbalancedTransactions.length === 0 && total === 0 && negative === 0,
    walletMismatches,
    unbalancedTransactions,
    totalOfAllBalancesPaise: total, // money only moves between wallets, so this is always 0
    negativeUserWallets: negative,
  };
}
