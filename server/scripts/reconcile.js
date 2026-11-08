// Audits the whole ledger. Exit code 1 if any invariant is broken. Usage: npm run reconcile
import { pool } from '../src/db.js';
import { reconcileAll } from '../src/payments.js';

const report = await reconcileAll();
console.log(JSON.stringify(report, null, 2));
console.log(report.ok ? 'Ledger is consistent.' : 'LEDGER PROBLEM FOUND.');
await pool.end();
process.exit(report.ok ? 0 : 1);
