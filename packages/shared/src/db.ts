/* eslint-disable max-classes-per-file -- the IMMEDIATE driver and the dialect that builds it */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  sql,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type SqliteDialectConfig,
  type TransactionSettings
} from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { LogLevelOverride } from './columnValues.js';
import type { DB } from './generated/db.js';

export type Db = Kysely<DB>;

/** The `log_level` and `log_level_expires_at` pair a `users`, `trunks` or `ring_groups` row
 * carries: its diagnostics override (§7, §11.2). */
export type LogLevelColumns = {
  logLevel: LogLevelOverride | null;
  logLevelExpiresAt: string | null;
};

// Transactions begin IMMEDIATE, taking the write lock up front: a deferred transaction that reads,
// then writes after another connection committed, fails at once with SQLITE_BUSY_SNAPSHOT, which
// busy_timeout cannot wait out (§3.1). A transaction set `read only` writes nothing, so it begins
// DEFERRED and leaves the write lock to the writers; SQLite itself does not enforce the mode.
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(
    connection: DatabaseConnection,
    settings?: TransactionSettings
  ): Promise<void> {
    await connection.executeQuery(
      CompiledQuery.raw(
        settings?.accessMode === 'read only'
          ? 'begin deferred'
          : 'begin immediate'
      )
    );
  }
}

class ImmediateSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  override createDriver(): SqliteDriver {
    return new ImmediateSqliteDriver(this.#config);
  }
}

/* eslint-enable max-classes-per-file */

// journal_mode/foreign_keys/busy_timeout/synchronous mirror the deployed stack (§3.1, §6.6);
// setting them on ':memory:' is a harmless no-op, so `openDb(':memory:')` stays test-friendly.
export function openDb(file: string): Db {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  return new Kysely<DB>({
    dialect: new ImmediateSqliteDialect({ database }),
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

/** Kysely's migrator over the migrations in `dir` (db/migrations, wherever the caller has it). */
export function migrator(db: Db, dir: string): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: dir
    })
  });
}

export async function pendingMigrations(
  db: Db,
  dir: string
): Promise<string[]> {
  const migrations = await migrator(db, dir).getMigrations();
  return migrations
    .filter(migration => !migration.executedAt)
    .map(migration => migration.name);
}
