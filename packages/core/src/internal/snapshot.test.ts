import { beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { ConfigCache } from './snapshot.js';

/** The minimum a snapshot needs: `settings` and the main DID its FK points at. */
async function seedSettings(db: Db): Promise<{ didId: string }> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+15550000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+15551234', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId: didId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
  return { didId };
}

describe('ConfigCache snapshot', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    await seedSettings(db);
  });

  it('leaves out soft-deleted rows, so they stop routing (§5.9, §11.1)', async () => {
    const userId = newId();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'Deleted User',
        email: `${userId}@example.com`,
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();
    const didId = newId();
    await db
      .insertInto('dids')
      .values({
        id: didId,
        number: '+15559999',
        targetId: (
          await db
            .selectFrom('forwardTargets')
            .select('id')
            .executeTakeFirstOrThrow()
        ).id,
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();
    await db
      .insertInto('blockedNumbers')
      .values({
        id: newId(),
        number: '+15558888',
        isPrefix: 0,
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();

    const snapshot = await new ConfigCache(db).get();

    // A soft-deleted row stays readable for the undo window (§5.8) but must not route, block or
    // ring: the pipeline reads this snapshot and has no delete filter of its own.
    expect(snapshot.users.map(row => row.id)).not.toContain(userId);
    expect(snapshot.dids.map(row => row.id)).not.toContain(didId);
    expect(snapshot.blockedNumbers).toHaveLength(0);
  });

  it('keeps live rows', async () => {
    const userId = newId();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'Live User',
        email: `${userId}@example.com`,
        createdAt: nowIso()
      })
      .execute();

    const snapshot = await new ConfigCache(db).get();

    expect(snapshot.users.map(row => row.id)).toContain(userId);
  });
});
