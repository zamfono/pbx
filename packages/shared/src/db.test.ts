import { expect, test } from 'vitest';

import { isDbOpen, openDb, pendingMigrations } from './db.js';
import { migrateForTest, MIGRATIONS_DIR } from './testDb.js';

test('migrates and enforces the schema', async () => {
  const db = openDb(':memory:');
  expect(await pendingMigrations(db, MIGRATIONS_DIR)).toHaveLength(3);
  await migrateForTest(db);
  expect(await pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);

  const tables = (await db.introspection.getTables())
    .map(table => table.name)
    .sort();
  expect(tables).toHaveLength(48);

  // settings.smtp_check_interval_s: 900 by default, NULL for no periodic relay check (§11.4)
  const settings = (await db.introspection.getTables()).find(
    table => table.name === 'settings'
  );
  expect(
    settings?.columns.find(column => column.name === 'smtp_check_interval_s')
  ).toMatchObject({ isNullable: true, hasDefaultValue: true });

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

  // sip_bans.address is lower-case: the /64 key core and api compare (§11.2)
  await expect(
    db
      .insertInto('sipBans')
      .values({
        id: 'b1',
        address: '2001:DB8::/64',
        step: 1,
        failures: 10,
        createdAt: 't'
      })
      .execute()
  ).rejects.toThrow(/CHECK/u);

  // foreign keys on
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

test('isDbOpen answers until the database is closed', async () => {
  const db = openDb(':memory:');
  expect(await isDbOpen(db)).toBe(true);
  await db.destroy();
  expect(await isDbOpen(db)).toBe(false);
});
