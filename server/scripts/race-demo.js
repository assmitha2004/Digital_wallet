// Shows WHY the locking in payments.js exists, with real numbers.  Usage: npm run race-demo
//
// Experiment 1 — double-spending:
//   A wallet has ₹100. 50 requests each try to send ₹10 at the same moment.
//   Correct answer: 10 succeed, 40 are refused, ₹0 left.
//
// Experiment 2 — deadlocks:
//   Two wallets send ₹1 to each other 100 times at once (A->B and B->A).
//   Locking "sender first" can deadlock; locking "lower id first" cannot.
//
// It uses its own scratch table (demo_wallets), so it never touches real data.
import { pool } from '../src/db.js';

const START_PAISE = 10000;
const AMOUNT = 1000;
const REQUESTS = 50;

async function resetDemoTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS demo_wallets (
    id INT PRIMARY KEY, balance_paise BIGINT NOT NULL) ENGINE=InnoDB`);
  await pool.query('DELETE FROM demo_wallets');
  await pool.query('INSERT INTO demo_wallets VALUES (1, ?), (2, 0)', [START_PAISE]);
}

async function inTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** WRONG: read, check, then write the number we computed in JavaScript. */
function naiveTransfer() {
  return inTransaction(async (conn) => {
    const [[sender]] = await conn.query('SELECT balance_paise FROM demo_wallets WHERE id = 1');
    if (sender.balance_paise < AMOUNT) return 'refused';
    await new Promise((resolve) => setTimeout(resolve, 2)); // real apps do work here (validation, logging...)
    await conn.query('UPDATE demo_wallets SET balance_paise = ? WHERE id = 1', [sender.balance_paise - AMOUNT]);
    await conn.query('UPDATE demo_wallets SET balance_paise = balance_paise + ? WHERE id = 2', [AMOUNT]);
    return 'sent';
  });
}

/** RIGHT: lock the row first, so the check and the write see the same balance. */
function lockedTransfer() {
  return inTransaction(async (conn) => {
    const [[sender]] = await conn.query('SELECT balance_paise FROM demo_wallets WHERE id = 1 FOR UPDATE');
    if (sender.balance_paise < AMOUNT) return 'refused';
    await new Promise((resolve) => setTimeout(resolve, 2));
    await conn.query('UPDATE demo_wallets SET balance_paise = balance_paise - ? WHERE id = 1', [AMOUNT]);
    await conn.query('UPDATE demo_wallets SET balance_paise = balance_paise + ? WHERE id = 2', [AMOUNT]);
    return 'sent';
  });
}

async function runDoubleSpend(label, transferFn) {
  await resetDemoTable();
  const outcomes = await Promise.all(Array.from({ length: REQUESTS }, () => transferFn()));
  const [[a], [b]] = (await pool.query('SELECT balance_paise FROM demo_wallets ORDER BY id'))[0].map((row) => [row]);
  const sent = outcomes.filter((outcome) => outcome === 'sent').length;
  const totalAfter = a.balance_paise + b.balance_paise;
  return {
    method: label,
    'transfers accepted (correct: 10)': sent,
    'sender left (₹)': a.balance_paise / 100,
    'receiver got (₹)': b.balance_paise / 100,
    'money created out of nothing (₹)': (totalAfter - START_PAISE) / 100,
  };
}

async function runDeadlocks(label, orderedLocks) {
  await resetDemoTable();
  await pool.query('UPDATE demo_wallets SET balance_paise = 100000');
  let deadlocks = 0;
  const transferBetween = (from, to) =>
    inTransaction(async (conn) => {
      const lockOrder = orderedLocks ? [from, to].sort((x, y) => x - y) : [from, to];
      for (const id of lockOrder) {
        await conn.query('SELECT balance_paise FROM demo_wallets WHERE id = ? FOR UPDATE', [id]);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await conn.query('UPDATE demo_wallets SET balance_paise = balance_paise - 100 WHERE id = ?', [from]);
      await conn.query('UPDATE demo_wallets SET balance_paise = balance_paise + 100 WHERE id = ?', [to]);
    }).catch((err) => {
      if (err.code === 'ER_LOCK_DEADLOCK') deadlocks++;
      else throw err;
    });
  await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? transferBetween(1, 2) : transferBetween(2, 1))));
  return { method: label, 'deadlocks out of 100 transfers': deadlocks };
}

console.log(`\nExperiment 1: ${REQUESTS} simultaneous ₹${AMOUNT / 100} transfers from a ₹${START_PAISE / 100} wallet\n`);
console.table([
  await runDoubleSpend('read, check, write (no lock)', naiveTransfer),
  await runDoubleSpend('SELECT ... FOR UPDATE', lockedTransfer),
]);

console.log('\nExperiment 2: 100 simultaneous transfers, half A->B and half B->A\n');
console.table([await runDeadlocks('lock sender first', false), await runDeadlocks('lock lower id first', true)]);

await pool.query('DROP TABLE IF EXISTS demo_wallets');
await pool.end();
