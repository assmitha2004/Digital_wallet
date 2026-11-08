// Load test over real HTTP. Usage: npm run benchmark   (uses DATABASE_URL; WIPES its tables — use a scratch DB)
// Env: BENCH_USERS (default 50), BENCH_REQUESTS (2000), BENCH_CONCURRENCY (50)
import crypto from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { reconcileAll } from '../src/payments.js';
import { migrate } from './migrate.js';

const USERS = Number(process.env.BENCH_USERS ?? 50);
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 50);

await migrate();
await pool.query('SET FOREIGN_KEY_CHECKS = 0');
for (const table of ['ledger_entries', 'transactions', 'idempotency_keys', 'wallets', 'users']) await pool.query(`TRUNCATE TABLE ${table}`);
await pool.query('SET FOREIGN_KEY_CHECKS = 1');
await pool.query("INSERT INTO wallets (id, user_id, kind, balance_paise) VALUES (1, NULL, 'SYSTEM', 0)");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

const users = [];
for (let i = 0; i < USERS; i++) {
  const email = `bench${i}@bench.dev`;
  const res = await post('/auth/register', { name: `Bench ${i}`, email, password: 'password123' });
  users.push({ email, token: (await res.json()).token });
}
await Promise.all(users.map((user) => post('/wallet/topups', { amount: '50000' }, user.token)));

const latencies = [];
const statuses = {};
let next = 0;
async function worker() {
  while (next < REQUESTS) {
    next++;
    const from = users[Math.floor(Math.random() * USERS)];
    let to = users[Math.floor(Math.random() * USERS)];
    if (to === from) to = users[(users.indexOf(from) + 1) % USERS];
    const started = performance.now();
    const res = await post('/transfers', { toEmail: to.email, amount: String(1 + Math.floor(Math.random() * 500)) }, from.token);
    await res.arrayBuffer();
    latencies.push(performance.now() - started);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(1);
const report = await reconcileAll();

console.table({
  'transfers sent': REQUESTS,
  'concurrent clients': CONCURRENCY,
  'users': USERS,
  'HTTP status counts': JSON.stringify(statuses),
  'throughput (transfers/s)': Math.round(REQUESTS / seconds),
  'p50 latency (ms)': pct(50),
  'p95 latency (ms)': pct(95),
  'p99 latency (ms)': pct(99),
  'ledger consistent after load': report.ok,
});

server.close();
await pool.end();
