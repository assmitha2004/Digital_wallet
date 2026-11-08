import mysql from 'mysql2/promise';
import { config } from './config.js';

function sslOptions() {
  if (!config.dbSsl) return undefined;
  return config.dbCaCert
    ? { ca: config.dbCaCert.replace(/\\n/g, '\n'), rejectUnauthorized: true }
    : { rejectUnauthorized: true };
}

// Parse the URL ourselves so provider-specific query options (e.g. TiDB's "?ssl=...") cannot
// silently override the TLS settings below.
const dbUrl = new URL(config.databaseUrl);

export const pool = mysql.createPool({
  host: dbUrl.hostname,
  port: Number(dbUrl.port || 3306),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: decodeURIComponent(dbUrl.pathname.slice(1)),
  connectionLimit: config.dbPoolSize,
  waitForConnections: true,
  timezone: 'Z',
  supportBigNumbers: true,
  decimalNumbers: true, // SUM() returns DECIMAL; read it as a JS number (safe: paise totals fit in 2^53)
  ssl: sslOptions(),
});

/**
 * Runs `work(conn)` inside one database transaction.
 * Commit if it returns, roll back if it throws. Either all writes happen or none do.
 */
export async function withTransaction(work) {
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

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * InnoDB may abort a transaction to break a deadlock. That is safe to retry because
 * the aborted transaction wrote nothing. We lock rows in a fixed order so this is rare.
 */
export async function withRetry(work, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
}
