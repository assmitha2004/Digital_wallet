import crypto from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { config } from '../src/config.js';
import { currentStep, hotp } from '../src/totp.js';

export const api = () => request(app);

let migrated = false;

/** Empties every table (keeps the SYSTEM wallet) so each test starts clean. */
export async function resetDatabase() {
  if (!migrated) {
    await migrate(process.env.DATABASE_URL);
    migrated = true;
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ['payment_requests', 'gateway_orders', 'ledger_entries', 'transactions', 'idempotency_keys', 'refresh_tokens', 'audit_logs', 'wallets', 'users']) {
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
  return { id: res.body.user.id, token: res.body.accessToken, email, auth: { Authorization: `Bearer ${res.body.accessToken}` }, cookie: res.headers['set-cookie'] };
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

// ---- Sessions and 2FA ---------------------------------------------------------------------

/** Logs in; returns the response plus the refresh cookie and auth header for convenience. */
export async function login(email, password = 'password123', otp) {
  const res = await api().post('/api/auth/login').send({ email, password, ...(otp && { otp }) });
  return Object.assign(res, {
    cookie: res.headers['set-cookie'],
    auth: res.body.accessToken ? { Authorization: `Bearer ${res.body.accessToken}` } : undefined,
  });
}

export const refreshWith = (cookie) => api().post('/api/auth/refresh').set('Cookie', cookie).set('X-PayLedger-Client', 'test');

/** Code for the current 30-second step, shifted by `offset` steps (the server accepts -1..+1). */
export const codeFor = (secret, offset = 0) => hotp(secret, currentStep() + offset);

/** Turns on 2FA for a user and returns the secret. */
export async function enableTwoFactor(user) {
  const setup = await api().post('/api/auth/2fa/setup').set(user.auth);
  const secret = setup.body.secret;
  const enabled = await api().post('/api/auth/2fa/enable').set(user.auth).send({ code: codeFor(secret) });
  if (enabled.status !== 200) throw new Error(`2FA enable failed: ${JSON.stringify(enabled.body)}`);
  return secret;
}

/** Temporarily changes a config value inside one test. */
export function withConfig(object, changes) {
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, object[key]]));
  Object.assign(object, changes);
  return () => Object.assign(object, previous);
}

export { config };
