// The migrate image's entry point (spec §6.3 "Migrations"): applies db/migrations to the database
// DB_FILE names with Kysely's Migrator and exits 0 once every migration is applied. A database
// file another process briefly holds locked, which better-sqlite3 reports as SQLITE_BUSY or
// SQLITE_LOCKED, is retried five times at 5 s intervals; a migration that fails on its own merits
// exits 1 at once, so a broken release stops the deployment without running its failing migration
// again. Node runs this file directly (type stripping).
import console from 'node:console';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;
// The primary result codes and their extended forms, such as SQLITE_BUSY_RECOVERY.
const LOCKED_CODE = /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u;

const dbFile = process.env.DB_FILE;
if (!dbFile) {
  throw new Error('DB_FILE environment variable is required.');
}

function isLocked(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && LOCKED_CODE.test(code);
}

/** One run of the migrator; throws what it failed with. A relative DB_FILE is the root's. */
async function migrateOnce(file: string): Promise<void> {
  const db = new Kysely<unknown>({
    dialect: new SqliteDialect({
      database: new Database(path.resolve(import.meta.dirname, '..', file))
    })
  });
  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(import.meta.dirname, 'migrations')
      })
    });
    const { error, results = [] } = await migrator.migrateToLatest();
    for (const result of results) {
      console.log(`${result.migrationName}: ${result.status}`);
    }
    if (error !== undefined) {
      throw error instanceof Error
        ? error
        : new Error('migration failed', { cause: error });
    }
    if (results.length === 0) {
      console.log('no new migrations to apply');
    }
  } finally {
    await db.destroy();
  }
}

/** Migrates from `attempt` on, retrying only while the database file is locked. */
async function migrate(file: string, attempt: number): Promise<number> {
  try {
    await migrateOnce(file);
    return 0;
  } catch (error) {
    console.error(error);
    if (!isLocked(error)) {
      console.error('migration failed; not retrying');
      return 1;
    }
  }
  if (attempt === ATTEMPTS) {
    console.error(`database still locked after ${String(ATTEMPTS)} attempts`);
    return 1;
  }
  console.error(
    `migration attempt ${String(attempt)} found the database locked; retrying in 5s`
  );
  await sleep(RETRY_DELAY_MS);
  return migrate(file, attempt + 1);
}

process.exitCode = await migrate(dbFile, 1);
