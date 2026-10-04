import path from 'node:path';
import { sql, type Insertable } from 'kysely';

import { migrator, openDb, type Db } from './db.js';
import type { FeatureCodes } from './featureCodes.js';
import type { DB } from './generated/db.js';
import { newId } from './ids.js';
import { featureCodesColumn } from './jsonColumns.js';
import { nowIso } from './time.js';

/** A row of `Table` a seeder inserts, any column overridden. */
export type Row<Table extends keyof DB> = Partial<Insertable<DB[Table]>>;

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
    return featureCodesColumn.decode(json);
  } finally {
    await db.destroy();
  }
}

/** A DID `number` routed to `targetId`, or to a forward target of its own that forwards to an
 * external number. Returns its id. */
export async function seedDid(
  db: Db,
  number: string,
  targetId?: string
): Promise<string> {
  let didTargetId = targetId;
  if (didTargetId === undefined) {
    didTargetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: didTargetId, external: '+15550000' })
      .execute();
  }
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, targetId: didTargetId, createdAt: nowIso() })
    .execute();
  return id;
}

/** The `settings` singleton, `settings` on top. Unless `settings.mainDidId` names one, the main
 * DID is `+15551234`, forwarding to an external number. Returns the main DID's id. */
export async function seedSettings(
  db: Db,
  settings: Row<'settings'> = {}
): Promise<string> {
  const mainDidId = settings.mainDidId ?? (await seedDid(db, '+15551234'));
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      ...settings,
      mainDidId
    })
    .execute();
  return mainDidId;
}

/** A user, `user` on top, at extension `ext` if one is given. Returns its id. */
export async function seedUser(
  db: Db,
  { ext, ...user }: Row<'users'> & { ext?: string } = {}
): Promise<string> {
  const id = user.id ?? newId();
  await db
    .insertInto('users')
    .values({
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso(),
      ...user,
      id
    })
    .execute();
  if (ext !== undefined) {
    await db
      .insertInto('extensions')
      .values({ ext, userId: id, ringGroupId: null, isParkingSlot: 0 })
      .execute();
  }
  return id;
}
