// Daily housekeeping. Usage: npm run cleanup   (Vercel runs the same thing via Cron)
import { pool } from '../src/db.js';
import { runCleanup } from '../src/maintenance.js';

const removed = await runCleanup();
console.log(`Removed ${removed.idempotencyKeys} expired idempotency key(s) and ${removed.refreshTokens} old refresh token(s).`);
await pool.end();
