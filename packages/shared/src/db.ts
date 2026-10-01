import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { CamelCasePlugin, Kysely, sql, SqliteDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { DB } from './generated/db.js';

export type Db = Kysely<DB>;

/**
 * db/migrations, found from this file in a checkout. The api image sets MIGRATIONS_DIR: its Vite
 * build bundles this module into a server chunk, away from db/.
 */
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  path.resolve(import.meta.dirname, '../../../db/migrations');

// journal_mode/foreign_keys/busy_timeout/synchronous mirror the deployed stack (§3.1, §6.6);
// setting them on ':memory:' is a harmless no-op, so `openDb(':memory:')` stays test-friendly.
export function openDb(file: string): Db {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database }),
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })]
  });
}

/** Whether `db` answers a trivial query, the database check of `api`'s and core's `/healthz` (§7). */
export async function isDbOpen(db: Db): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

/** Kysely's migrator over db/migrations. */
export function migrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_DIR
    })
  });
}

export async function pendingMigrations(db: Db): Promise<string[]> {
  const migrations = await migrator(db).getMigrations();
  return migrations
    .filter(migration => !migration.executedAt)
    .map(migration => migration.name);
}
