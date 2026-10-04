import { describe, expect, it } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#testing/testDb.js';

import { ringGroupMemberships } from './ringGroupMembership.js';

/** Ring group `rg` holding `u1` directly and `u2` through `parent` → `child`. */
async function seededDb(): Promise<Db> {
  const db = await makeTestDb();
  const createdAt = nowIso();
  await db
    .insertInto('users')
    .values(
      ['u1', 'u2'].map(id => ({
        id,
        name: id,
        email: `${id}@x`,
        role: 'user',
        passwordHash: 'x',
        createdAt
      }))
    )
    .execute();
  await db
    .insertInto('userGroups')
    .values([
      { id: 'parent', name: 'Parent', createdAt },
      { id: 'child', name: 'Child', createdAt }
    ])
    .execute();
  await db
    .insertInto('userGroupGroups')
    .values({ parentGroupId: 'parent', childGroupId: 'child' })
    .execute();
  await db
    .insertInto('userGroupUsers')
    .values({ groupId: 'child', userId: 'u2' })
    .execute();
  await db
    .insertInto('ringGroups')
    .values({ id: 'rg', name: 'Sales', strategy: 'simultaneous', createdAt })
    .execute();
  await db
    .insertInto('ringGroupMembers')
    .values([
      { groupId: 'rg', position: 0, userId: 'u1' },
      { groupId: 'rg', position: 1, userGroupId: 'parent' }
    ])
    .execute();
  return db;
}

async function memberIds(db: Db): Promise<string[]> {
  const rows = await ringGroupMemberships(db, { ringGroupId: 'rg' });
  return rows.map(row => row.userId).sort();
}

describe('ringGroupMemberships', () => {
  it('flattens nested user groups, for a ring group or a user', async () => {
    const db = await seededDb();
    expect(await memberIds(db)).toEqual(['u1', 'u2']);
    expect(await ringGroupMemberships(db, { userId: 'u2' })).toEqual([
      { ringGroupId: 'rg', userId: 'u2' }
    ]);
  });

  // §5.9: a membership survives its member's soft delete, and the member is skipped meanwhile.
  it('skips a soft-deleted user', async () => {
    const db = await seededDb();
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'u1')
      .execute();
    expect(await memberIds(db)).toEqual(['u2']);
  });

  it('skips a soft-deleted user group, nested or not', async () => {
    const db = await seededDb();
    await db
      .updateTable('userGroups')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'child')
      .execute();
    expect(await memberIds(db)).toEqual(['u1']);
    await db
      .updateTable('userGroups')
      .set({ deletedAt: null })
      .where('id', '=', 'child')
      .execute();
    await db
      .updateTable('userGroups')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'parent')
      .execute();
    expect(await memberIds(db)).toEqual(['u1']);
  });

  it('skips a soft-deleted ring group', async () => {
    const db = await seededDb();
    await db
      .updateTable('ringGroups')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'rg')
      .execute();
    expect(await ringGroupMemberships(db)).toEqual([]);
  });
});
