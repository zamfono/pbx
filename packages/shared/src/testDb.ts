import { migrator, type Db } from './db.js';

/** Applies the migrations up to and including `to`, or all of them when it is left out. */
export async function migrateForTest(db: Db, to?: string): Promise<void> {
  const { error } = await (to === undefined
    ? migrator(db).migrateToLatest()
    : migrator(db).migrateTo(to));
  if (error) {
    throw error instanceof Error
      ? error
      : new Error('migration failed', { cause: error });
  }
}
