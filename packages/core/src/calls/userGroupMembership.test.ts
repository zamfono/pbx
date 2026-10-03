import { describe, expect, it } from 'vitest';

import { nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { ConfigCache, type Snapshot } from '../internal/snapshot.js';
import { seedSettings, seedUser } from '../testing/seedRows.js';
import { groupMemberUserIds } from './extensionOwner.js';
import { callerGroupIds } from './outboundLookup.js';

/**
 * Ring group `rg` holding user `u1` through user group `parent`, which nests `child`, which holds
 * `u1`; `deleted` names the user groups soft-deleted (§5.9: their rows stay, and they are skipped).
 */
async function snapshotWith(deleted: string[]): Promise<Snapshot> {
  const db: Db = openDb(':memory:');
  await migrateForTest(db);
  const createdAt = nowIso();
  await seedSettings(db);
  await seedUser(db, { id: 'u1', name: 'Member', email: 'u1@x', createdAt });
  await db
    .insertInto('userGroups')
    .values(
      ['parent', 'child'].map(id => ({
        id,
        name: id,
        createdAt,
        deletedAt: deleted.includes(id) ? createdAt : null
      }))
    )
    .execute();
  await db
    .insertInto('userGroupGroups')
    .values({ parentGroupId: 'parent', childGroupId: 'child' })
    .execute();
  await db
    .insertInto('userGroupUsers')
    .values({ groupId: 'child', userId: 'u1' })
    .execute();
  await db
    .insertInto('ringGroups')
    .values({ id: 'rg', name: 'Sales', strategy: 'simultaneous', createdAt })
    .execute();
  await db
    .insertInto('ringGroupMembers')
    .values({ groupId: 'rg', position: 0, userGroupId: 'parent' })
    .execute();
  return new ConfigCache(db).get();
}

describe('user-group membership', () => {
  it('reaches a user through nested user groups', async () => {
    const snapshot = await snapshotWith([]);
    expect(groupMemberUserIds(snapshot, 'rg')).toEqual(['u1']);
    expect(callerGroupIds('u1', snapshot).sort()).toEqual(['child', 'parent']);
  });

  it('skips a soft-deleted user group, nested or not', async () => {
    for (const deleted of ['child', 'parent']) {
      // eslint-disable-next-line no-await-in-loop -- one database per case
      const snapshot = await snapshotWith([deleted]);
      expect(groupMemberUserIds(snapshot, 'rg')).toEqual([]);
      expect(callerGroupIds('u1', snapshot)).not.toContain(deleted);
    }
  });
});
