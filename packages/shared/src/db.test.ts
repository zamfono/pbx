import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { isDbOpen, migrator, openDb, pendingMigrations } from './db.js';
import { migrateForTest, MIGRATIONS_DIR, seedSettings } from './testDb.js';

test('migrates and enforces the schema', async () => {
  const db = openDb(':memory:');
  expect(await pendingMigrations(db, MIGRATIONS_DIR)).toHaveLength(20);
  await migrateForTest(db);
  expect(await pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);

  const tables = (await db.introspection.getTables())
    .map(table => table.name)
    .sort();
  expect(tables).toHaveLength(52);

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

  // an owner may lack a password until they set one; they cannot log in meanwhile (§5.2)
  await expect(
    db
      .insertInto('users')
      .values({
        id: 'o1',
        name: 'O',
        email: 'o@x',
        role: 'owner',
        createdAt: 't'
      })
      .execute()
  ).resolves.toBeDefined();

  // a user needs an e-mail or an extension; an owner or admin needs an e-mail (§11.2)
  await expect(
    db
      .insertInto('users')
      .values({ id: 'a1', name: 'A', role: 'admin', createdAt: 't' })
      .execute()
  ).rejects.toThrow(/CHECK constraint failed: users_staff_email/u);
  await db
    .insertInto('users')
    .values({ id: 'p1', name: 'Lobby phone', createdAt: 't' })
    .execute();
  await db
    .insertInto('extensions')
    .values({ ext: '101', userId: 'p1' })
    .execute();
  await expect(
    db.deleteFrom('extensions').where('ext', '=', '101').execute()
  ).rejects.toThrow(/a user needs an e-mail or an extension/u);
  await expect(
    db
      .updateTable('users')
      .set({ email: null })
      .where('id', '=', 'u2')
      .execute()
  ).rejects.toThrow(/a user needs an e-mail or an extension/u);

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
        protocol: 'udp',
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

test('the dndToggle migration gives a stack that remapped its codes a code of its own (§9.3)', async () => {
  const db = openDb(':memory:');
  const steps = migrator(db, MIGRATIONS_DIR);
  await steps.migrateTo('1792310400000_yealink_devices');
  const remapped = {
    pickup: '*8',
    dndOn: '*90',
    dndOff: '*91',
    mailbox: '*95',
    ownVoicemail: '*96',
    deposit: '*97',
    addParty: '*5',
    clirOn: '#31#',
    clirOff: '*31#',
    park: '*92'
  };
  await seedSettings(db, { featureCodesJson: JSON.stringify(remapped) });
  await steps.migrateToLatest();
  const row = await db
    .selectFrom('settings')
    .select('featureCodesJson')
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.featureCodesJson)).toEqual({
    ...remapped,
    dndToggle: '*93'
  });
});

test('the sipBanProtocol migration keeps each ban on both protocols, its row as udp and a copy as tcp (§5.6)', async () => {
  const db = openDb(':memory:');
  const steps = migrator(db, MIGRATIONS_DIR);
  await steps.migrateTo('1794474331920_host_control');
  await sql`INSERT INTO sip_bans (id, address, step, failures, created_at, expires_at)
    VALUES ('active', '203.0.113.7', 2, 10, '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z'),
           ('ended', '198.51.100.1', 1, 10, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`.execute(
    db
  );
  await steps.migrateToLatest();
  const rows = await db
    .selectFrom('sipBans')
    .select(['id', 'address', 'protocol', 'step', 'expiresAt'])
    .orderBy('address')
    .orderBy('protocol')
    .execute();
  // Per address, the copy (tcp) sorts before the original row (udp).
  expect(rows).toEqual([
    expect.objectContaining({
      address: '198.51.100.1',
      protocol: 'tcp',
      step: 1,
      expiresAt: '2026-01-02T00:00:00.000Z'
    }),
    {
      id: 'ended',
      address: '198.51.100.1',
      protocol: 'udp',
      step: 1,
      expiresAt: '2026-01-02T00:00:00.000Z'
    },
    expect.objectContaining({
      address: '203.0.113.7',
      protocol: 'tcp',
      step: 2,
      expiresAt: '2999-01-01T00:00:00.000Z'
    }),
    {
      id: 'active',
      address: '203.0.113.7',
      protocol: 'udp',
      step: 2,
      expiresAt: '2999-01-01T00:00:00.000Z'
    }
  ]);
  expect(rows[2]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  await expect(
    db
      .insertInto('sipBans')
      .values({
        id: 'x',
        address: '203.0.113.8',
        protocol: 'tls' as never,
        step: 1,
        failures: 10,
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .execute()
  ).rejects.toThrow(/CHECK constraint failed/u);
});
