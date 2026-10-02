import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

/** An in-memory, migrated database seeded with one `owner` user, for operation tests. */
export async function makeTestDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'owner',
      name: 'Owner',
      email: 'owner@x',
      role: 'owner',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
  return db;
}

/** Adds the `settings` row, with a main DID, its clock in `timezone` (`null`: unset), for a test
 * that reads it. */
export async function seedTenantTimeZone(
  db: Db,
  timezone: string | null
): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId: 'owner' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+491234567', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test',
      mainDidId: didId,
      country: 'DE',
      timezone,
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}
