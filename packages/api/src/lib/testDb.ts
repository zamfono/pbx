import { nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

/** An in-memory, migrated database seeded with one `owner` user, for operation tests (Task 5). */
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
