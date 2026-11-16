// Applies database migrations in order. Usage: npm run migrate   (safe to run any number of times)
// Works on MySQL 8 and on TiDB Cloud (MySQL-compatible).
//
// How it works:
//   - Migrations are numbered files in server/db/migrations (001_initial.sql, 002_..., ...).
//   - Applied versions are recorded in the schema_migrations table, so each file runs once.
//   - DDL in MySQL is not transactional: if a file fails half-way, some statements already ran.
//     So statements run one at a time, and "already exists" errors (duplicate column, index,
//     constraint or table) count as done. Re-running a half-applied file finishes it.
//   - A database that existed before versioning starts at 001, whose statements are all
//     CREATE TABLE IF NOT EXISTS / INSERT IGNORE, so it is recorded without changing anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config, resolveDatabaseUrl } from '../src/config.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');

// MySQL / TiDB error codes that mean "this change is already in place".
const ALREADY_APPLIED = new Set([
  'ER_DUP_FIELDNAME', // 1060 duplicate column
  'ER_DUP_KEYNAME', // 1061 duplicate index
  'ER_TABLE_EXISTS_ERROR', // 1050
  'ER_FK_DUP_NAME', // 1826 duplicate foreign key name
  'ER_CHECK_CONSTRAINT_DUP_NAME', // 3822
]);

/** Lists migration files as { version, name, file }, sorted by version. */
export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: Number(file.slice(0, 3)), name: file.replace(/\.sql$/, ''), file: path.join(dir, file) }));
}

/** Splits a migration file into statements. Migrations contain no procedures, so ";" at a line end ends a statement. */
export function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function migrate(databaseUrl = config.databaseUrl, { log = () => {} } = {}) {
  const url = new URL(resolveDatabaseUrl(databaseUrl));
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error(`Put a database name at the end of DATABASE_URL (got "${database}")`);

  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
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
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT NOT NULL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);

    const [rows] = await connection.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const ran = [];

    for (const migration of listMigrations()) {
      if (applied.has(migration.version)) continue;
      for (const statement of splitStatements(fs.readFileSync(migration.file, 'utf8'))) {
        try {
          await connection.query(statement);
        } catch (err) {
          if (!ALREADY_APPLIED.has(err.code)) {
            throw new Error(`Migration ${migration.name} failed on:\n${statement}\n${err.message}`);
          }
        }
      }
      await connection.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [migration.version, migration.name]);
      log(`applied ${migration.name}`);
      ran.push(migration.name);
    }
    return { version, database, ran };
  } finally {
    await connection.end();
  }
}

/** Latest migration version recorded in the database (used by the readiness check). */
export async function appliedVersion(db) {
  const [[row]] = await db.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
  return row.version;
}

export const latestVersion = () => listMigrations().at(-1).version;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate(undefined, { log: (line) => console.log(line) })
    .then(({ version, database, ran }) =>
      console.log(`Database "${database}" is up to date (${version}). ${ran.length ? `Applied ${ran.length} migration(s).` : 'Nothing to apply.'}`),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
