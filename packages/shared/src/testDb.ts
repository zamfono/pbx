import { migrator, type Db } from './db.js';

/** Applies every migration. */
export async function migrateForTest(db: Db): Promise<void> {
  const { error } = await migrator(db).migrateToLatest();
  if (error) {
    throw error instanceof Error
      ? error
      : new Error('migration failed', { cause: error });
  }
}
