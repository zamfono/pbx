import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { Db } from './db.js';

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '../../../db/migrations'
);

export async function migrateForTest(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_DIR
    })
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error
      ? error
      : new Error('migration failed', { cause: error });
  }
}
