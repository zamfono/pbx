import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { defineConfig } from 'kysely-ctl';

// kysely-ctl's configuration, for `npm run migrate:create` in a checkout; the migrate image runs
// migrate.ts instead. Creating a migration only writes a file into migrations/, so the database
// kysely-ctl requires is an in-memory one.
export default defineConfig({
  dialect: 'better-sqlite3',
  dialectConfig: {
    database: new Database(':memory:')
  },
  migrations: {
    allowJS: false,
    migrationFolder: resolve(import.meta.dirname, 'migrations')
  }
});
