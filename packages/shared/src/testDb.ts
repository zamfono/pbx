import path from 'node:path';
import { sql } from 'kysely';

import { migrator, openDb, type Db } from './db.js';
import { featureCodesSchema, type FeatureCodes } from './featureCodes.js';

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

/** A fresh in-memory database with every migration applied. */
export async function migratedTestDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  return db;
}

/** The `settings.feature_codes_json` column default, as a migrated database declares it. */
export async function defaultFeatureCodes(): Promise<FeatureCodes> {
  const db = await migratedTestDb();
  try {
    const column = await sql<{ literal: string }>`
      select dflt_value as literal from pragma_table_info('settings')
      where name = 'feature_codes_json'`.execute(db);
    const literal = column.rows.at(0)?.literal;
    if (literal === undefined) {
      throw new Error('settings.feature_codes_json has no default');
    }
    // The default is declared as an SQL string literal; selecting it yields its text.
    const value = await sql<{
      json: string;
    }>`select ${sql.raw(literal)} as json`.execute(db);
    const json = value.rows.at(0)?.json;
    if (json === undefined) {
      throw new Error('settings.feature_codes_json default did not evaluate');
    }
    return featureCodesSchema.parse(JSON.parse(json));
  } finally {
    await db.destroy();
  }
}
