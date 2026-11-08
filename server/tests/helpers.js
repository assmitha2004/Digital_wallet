import crypto from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';

export const api = () => request(app);

let migrated = false;

/** Empties every table (keeps the SYSTEM wallet) so each test starts clean. */
export async function resetDatabase() {
  if (!migrated) {
    await migrate(process.env.DATABASE_URL);
    migrated = true;
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ['ledger_entries', 'transactions', 'idempotency_keys', 'wallets', 'users']) {
    await pool.query(`TRUNCATE TABLE ${table}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await pool.query("INSERT INTO wallets (id, user_id, kind, balance_paise) VALUES (1, NULL, 'SYSTEM', 0)");
}

export const newKey = () => crypto.randomUUID();

export async function createUser(name) {
  const email = `${name.toLowerCase()}@test.dev`;
  const res = await api().post('/api/auth/register').send({ name, email, password: 'password123' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, email, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export function addMoney(user, amount, key = newKey()) {
  return api().post('/api/wallet/topups').set(user.auth).set('Idempotency-Key', key).send({ amount });
}

export function sendMoney(from, to, amount, key = newKey(), note) {
  return api()
    .post('/api/transfers')
    .set(from.auth)
    .set('Idempotency-Key', key)
    .send({ toEmail: to.email, amount, ...(note && { note }) });
}

export async function balanceOf(user) {
  const res = await api().get('/api/me').set(user.auth);
  return res.body.wallet.balancePaise;
}
