// Creates the database and tables (safe to run many times). Usage: npm run migrate
// Works on MySQL 8 and on TiDB Cloud (MySQL-compatible).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql');

export async function migrate(databaseUrl = config.databaseUrl) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error(`Put a database name at the end of DATABASE_URL (got "${database}")`);

  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    multipleStatements: true,
    ssl: config.dbSsl ? { ca: config.dbCaCert?.replace(/\\n/g, '\n'), rejectUnauthorized: true } : undefined,
  });
  try {
    const [[{ version }]] = await connection.query('SELECT VERSION() AS version');
    if (version.includes('TiDB')) {
      // TiDB ignores CHECK constraints unless this is on. If the plan does not allow it,
      // the app's locking still prevents overdrafts; the CHECK is only a second safety net.
      await connection.query('SET GLOBAL tidb_enable_check_constraint = ON').catch((err) => {
        console.warn(`Could not enable CHECK constraints on TiDB (${err.message}). Continuing without them.`);
      });
    }
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    await connection.query(`USE \`${database}\``);
    await connection.query(fs.readFileSync(schemaPath, 'utf8'));
    return { version, database };
  } finally {
    await connection.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(({ version, database }) => console.log(`Database "${database}" is up to date (${version}).`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
