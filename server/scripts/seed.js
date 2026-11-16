// Creates demo accounts with some history. Safe to run more than once. Usage: npm run seed
// Log in as demo@payledger.dev / demo12345
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { runIdempotent } from '../src/idempotency.js';
import { topUp, transfer } from '../src/payments.js';
import { createRequest } from '../src/requests.js';

const PASSWORD = 'demo12345';
const people = [
  { name: 'Demo User', email: 'demo@payledger.dev' },
  { name: 'Karthik Raman', email: 'karthik@payledger.dev' },
  { name: 'Meera Iyer', email: 'meera@payledger.dev' },
];

const hash = await bcrypt.hash(PASSWORD, 10);
const ids = {};
for (const person of people) {
  await pool.execute('INSERT IGNORE INTO users (name, email, password_hash) VALUES (?, ?, ?)', [person.name, person.email, hash]);
  const [[user]] = await pool.execute('SELECT id FROM users WHERE email = ?', [person.email]);
  await pool.execute("INSERT IGNORE INTO wallets (user_id, kind) VALUES (?, 'USER')", [user.id]);
  ids[person.email] = user.id;
}

// Fixed idempotency keys make the seed itself idempotent: running it twice adds nothing.
const run = (userId, key, work) => runIdempotent({ userId, key, route: 'seed', body: { key } }, work);
await run(ids['demo@payledger.dev'], 'seed-topup-demo', (conn) => topUp(conn, { userId: ids['demo@payledger.dev'], amountPaise: 500000 }));
await run(ids['karthik@payledger.dev'], 'seed-topup-karthik', (conn) => topUp(conn, { userId: ids['karthik@payledger.dev'], amountPaise: 300000 }));
await run(ids['karthik@payledger.dev'], 'seed-xfer-1', (conn) =>
  transfer(conn, { userId: ids['karthik@payledger.dev'], toEmail: 'demo@payledger.dev', amountPaise: 45000, note: 'Concert tickets' }),
);
await run(ids['demo@payledger.dev'], 'seed-xfer-2', (conn) =>
  transfer(conn, { userId: ids['demo@payledger.dev'], toEmail: 'meera@payledger.dev', amountPaise: 12050, note: 'Dinner split' }),
);

// A payment request from Meera to the demo user, so the Requests tab has something in it.
await run(ids['meera@payledger.dev'], 'seed-request-1', (conn) =>
  createRequest(conn, { requesterUserId: ids['meera@payledger.dev'], fromEmail: 'demo@payledger.dev', amountPaise: 30000, note: 'Movie tickets' }),
);

// Admin access is never seeded with a public password. Set ADMIN_EMAIL to promote an
// existing account (e.g. your own) when deploying.
if (config.adminEmail) {
  const [result] = await pool.execute("UPDATE users SET role = 'ADMIN' WHERE email = ?", [config.adminEmail]);
  console.log(result.affectedRows ? `${config.adminEmail} is an ADMIN.` : `ADMIN_EMAIL ${config.adminEmail} has no account yet; register it, then re-run.`);
}

console.log(`Seeded. Log in as demo@payledger.dev / ${PASSWORD}`);
await pool.end();
