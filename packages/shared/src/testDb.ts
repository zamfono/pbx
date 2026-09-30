import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { Db } from './db.js';

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '../../../db/migrations'
);

/** Applies the migrations up to and including `to`, or all of them when it is left out. */
export async function migrateForTest(db: Db, to?: string): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_DIR
    })
  });
  const { error } = await (to === undefined
    ? migrator.migrateToLatest()
    : migrator.migrateTo(to));
  if (error) {
    throw error instanceof Error
      ? error
      : new Error('migration failed', { cause: error });
  }
}
