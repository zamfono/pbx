import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'kysely-ctl';

const rootPath = resolve(import.meta.dirname, '..');

// The stack's only `.env` lives at the repository root; every kysely-ctl script runs with cwd
// `db/`, so the path is resolved from this file rather than via `dotenv/config`. The `migrate`
// image carries no `.env` at all: dotenv silently skips a missing file, and Compose injects the
// environment instead (§6.3).
loadEnv({ path: resolve(rootPath, '.env') });

export const resolveDbFile = (dbFile: string): string =>
  dbFile === ':memory:' || isAbsolute(dbFile)
    ? dbFile
    : resolve(rootPath, dbFile);

const dbFile = process.env.DB_FILE;
if (!dbFile) {
  throw new Error('DB_FILE environment variable is required.');
}

export default defineConfig({
  dialect: 'better-sqlite3',
  dialectConfig: {
    database: new Database(resolveDbFile(dbFile))
  },
  migrations: {
    allowJS: false,
    migrationFolder: resolve(import.meta.dirname, 'migrations')
  }
});
