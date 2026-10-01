import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { defineConfig } from 'kysely-ctl';

// kysely-ctl's configuration, for `npm run migrate:create` in a checkout; the migrate image runs
// migrate.ts instead. kysely-ctl runs with cwd `db/`, so a `.env` at the repository root, where a
// developer may keep DB_FILE, is found from this file.
const rootPath = resolve(import.meta.dirname, '..');
const envFile = resolve(rootPath, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const resolveDbFile = (dbFile: string): string =>
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
