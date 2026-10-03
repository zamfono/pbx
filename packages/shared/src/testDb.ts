import path from 'node:path';

import { migrator, type Db } from './db.js';

/** db/migrations, found from this file in a checkout. */
export const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '../../../db/migrations'
);

/** Applies every migration. */
export async function migrateForTest(db: Db): Promise<void> {
  const { error } = await migrator(db, MIGRATIONS_DIR).migrateToLatest();
  if (error) {
    throw error instanceof Error
      ? error
      : new Error('migration failed', { cause: error });
  }
}
