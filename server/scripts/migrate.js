// Creates the tables (safe to run many times). Usage: npm run migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql');

export async function migrate(databaseUrl = config.databaseUrl) {
  const connection = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: true,
    ssl: config.dbSsl ? { ca: config.dbCaCert?.replace(/\\n/g, '\n'), rejectUnauthorized: true } : undefined,
  });
  try {
    await connection.query(fs.readFileSync(schemaPath, 'utf8'));
  } finally {
    await connection.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => console.log('Database schema is up to date.'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
