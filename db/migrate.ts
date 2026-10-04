// The migrate image's entry point (spec §6.3 "Migrations"): applies db/migrations to the database
// DB_FILE names, by default the stack's, with Kysely's Migrator and exits 0 once every migration
// is applied. A database file another process briefly holds locked, which better-sqlite3 reports
// as SQLITE_BUSY or SQLITE_LOCKED, is retried five times at 5 s intervals, six attempts in all; a migration that fails
// on its own merits exits 1 at once, so a broken release stops the deployment without running its
// failing migration again. Node runs this file directly (type stripping).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

// The source file itself, which the migrate image carries at the same path as a checkout does.
import { dbFileFrom } from '../packages/shared/src/stackPaths.ts';

const RETRIES = 5;
const ATTEMPTS = RETRIES + 1;
const RETRY_DELAY_MS = 5000;
// The primary result codes and their extended forms, such as SQLITE_BUSY_RECOVERY.
const LOCKED_CODE = /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u;

function isLocked(error: unknown): boolean {
  return error instanceof Database.SqliteError && LOCKED_CODE.test(error.code);
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

process.exitCode = await migrate(dbFileFrom(process.env.DB_FILE), 1);
