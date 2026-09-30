import { expect, test } from 'vitest';

import { openDb, pendingMigrations } from './db.js';
import { migrateForTest } from './testDb.js';

test('migrates and enforces the schema', async () => {
  const db = openDb(':memory:');
  expect(await pendingMigrations(db)).toHaveLength(4);
  await migrateForTest(db);
  expect(await pendingMigrations(db)).toEqual([]);

  const tables = (await db.introspection.getTables())
    .map(table => table.name)
    .sort();
  expect(tables).toHaveLength(42);

  // partial unique: two soft-deleted users may share an e-mail with a live one
  await db
    .insertInto('users')
    .values({
      id: 'u1',
      name: 'A',
      email: 'a@x',
      createdAt: '2026-01-01T00:00:00Z'
    })
    .execute();
  await db
    .updateTable('users')
    .set({ deletedAt: '2026-01-02T00:00:00Z' })
    .where('id', '=', 'u1')
    .execute();
  await expect(
    db
      .insertInto('users')
      .values({
        id: 'u2',
        name: 'B',
        email: 'a@x',
        createdAt: '2026-01-03T00:00:00Z'
      })
      .execute()
  ).resolves.toBeDefined();

  // trigger: nesting cycle
  await db
    .insertInto('userGroups')
    .values([
      { id: 'g1', name: 'g1', createdAt: 't' },
      { id: 'g2', name: 'g2', createdAt: 't' }
    ])
    .execute();
  await db
    .insertInto('userGroupGroups')
    .values({ parentGroupId: 'g1', childGroupId: 'g2' })
    .execute();
  await expect(
    db
      .insertInto('userGroupGroups')
      .values({ parentGroupId: 'g2', childGroupId: 'g1' })
      .execute()
  ).rejects.toThrow(/cycle/u);

  // trunks.emergency has no default (§11.2): every insert states it
  await expect(
    db
      .insertInto('trunks')
      .values({
        id: 't1',
        name: 't1',
        priority: 1,
        authMode: 'ip',
        createdAt: 't'
      } as never)
      .execute()
  ).rejects.toThrow(/NOT NULL constraint failed: trunks\.emergency/u);

  // foreign keys on, also after the trunks rebuild switched them off for its own run
  await expect(
    db
      .insertInto('devices')
      .values({
        id: 'd1',
        userId: 'nope',
        label: 'x',
        kind: 'manual',
        sipUsername: 'e1-d1',
        sipPasswordEnc: Buffer.alloc(1),
        createdAt: 't'
      })
      .execute()
  ).rejects.toThrow(/FOREIGN KEY/u);
});
