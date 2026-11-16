// Gives a user the ADMIN role. Usage: npm run make-admin -- someone@example.com
import { recordAudit } from '../src/audit.js';
import { pool } from '../src/db.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- <email>');
  process.exit(1);
}
const [result] = await pool.execute("UPDATE users SET role = 'ADMIN' WHERE email = ?", [email]);
if (result.affectedRows === 0) {
  console.error(`No user with email ${email}.`);
  process.exitCode = 1;
} else {
  const [[user]] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
  await recordAudit({ action: 'ROLE_GRANTED', targetType: 'user', targetId: user.id, metadata: { role: 'ADMIN', via: 'cli' } });
  console.log(`${email} is now an ADMIN.`);
}
await pool.end();
