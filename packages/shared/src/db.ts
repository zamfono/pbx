import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { DB } from './generated/db.js';

export type Db = Kysely<DB>;

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '../../../db/migrations'
);

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

export async function pendingMigrations(
  db: Db,
  dir: string = process.env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR
): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: dir })
  });
  const migrations = await migrator.getMigrations();
  return migrations
    .filter(migration => !migration.executedAt)
    .map(migration => migration.name);
}
