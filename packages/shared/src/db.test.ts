import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { isDbOpen, migrator, openDb, pendingMigrations } from './db.js';
import { migrateForTest, MIGRATIONS_DIR, seedSettings } from './testDb.js';

test('migrates and enforces the schema', async () => {
  const db = openDb(':memory:');
  expect(await pendingMigrations(db, MIGRATIONS_DIR)).toHaveLength(25);
  await migrateForTest(db);
  expect(await pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);

  const tables = (await db.introspection.getTables())
    .map(table => table.name)
    .sort();
  expect(tables).toHaveLength(56);

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

test('the decisions migration ties a condition naming a user to its type, and counts the new extension owners (§11.2)', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({ id: 'u1', name: 'A', email: 'a@x', createdAt: 't' })
    .execute();
  await db
    .insertInto('forwardTargets')
    .values([{ id: 'ft1' }, { id: 'ft2' }])
    .execute();
  await db
    .insertInto('decisions')
    .values({ id: 'd1', name: 'Main', defaultTargetId: 'ft1', createdAt: 't' })
    .execute();
  await db
    .insertInto('decisionCases')
    .values({ id: 'c1', decisionId: 'd1', position: 0, targetId: 'ft2' })
    .execute();
  const condition = { decisionId: 'd1', caseId: 'c1', parentId: null };
  // presence needs its user, callerUser may name one, every other type names none.
  await expect(
    db
      .insertInto('decisionConditions')
      .values({ id: 'p', ...condition, position: 0, type: 'presence' })
      .execute()
  ).rejects.toThrow(/CHECK constraint failed: decision_conditions_user/u);
  await expect(
    db
      .insertInto('decisionConditions')
      .values({
        id: 'd',
        ...condition,
        position: 0,
        type: 'dates',
        valueJson: '{"ranges":[]}',
        userId: 'u1'
      })
      .execute()
  ).rejects.toThrow(/CHECK constraint failed: decision_conditions_user/u);
  await expect(
    db
      .insertInto('decisionConditions')
      .values({
        id: 'a',
        ...condition,
        position: 0,
        type: 'any',
        valueJson: '{}'
      })
      .execute()
  ).rejects.toThrow(
    /CHECK constraint failed: decision_conditions_operator_payload/u
  );
  await db
    .insertInto('decisionConditions')
    .values([
      { id: 'cu', ...condition, position: 0, type: 'callerUser' },
      { id: 'pu', ...condition, position: 1, type: 'presence', userId: 'u1' }
    ])
    .execute();
  // A forward target names at most one target, a decision now among them.
  await expect(
    db
      .insertInto('forwardTargets')
      .values({ id: 'ft3', decisionId: 'd1', userId: 'u1' })
      .execute()
  ).rejects.toThrow(/CHECK constraint failed: forward_targets_one_kind/u);
  await db
    .insertInto('extensions')
    .values({ ext: '650', decisionId: 'd1' })
    .execute();
  await expect(
    db
      .insertInto('extensions')
      .values({ ext: '651', decisionId: 'd1' })
      .execute()
  ).rejects.toThrow(/UNIQUE constraint failed/u);
  await expect(
    db.insertInto('extensions').values({ ext: '652' }).execute()
  ).rejects.toThrow(/CHECK constraint failed: extensions_one_owner/u);
  // Deleting the decision takes its cases, conditions and extension with it.
  await db.deleteFrom('decisions').where('id', '=', 'd1').execute();
  expect(
    await db.selectFrom('decisionConditions').selectAll().execute()
  ).toEqual([]);
  expect(await db.selectFrom('extensions').select('ext').execute()).toEqual([]);
  await db.destroy();
});

test('takes templates in forward targets and decisions, and keeps the rows it migrates (§9.4 "Templates")', async () => {
  const db = openDb(':memory:');
  // The rows as they were before templates: an external, a recording sip and a plain target.
  await migrator(db, MIGRATIONS_DIR).migrateTo('1795003925117_decisions');
  await sql`insert into trunks (id, name, priority, emergency, auth_mode, inbound_auth, created_at)
    values ('t1', 'T', 1, 1, 'ip', 0, 't')`.execute(db);
  await sql`insert into forward_targets (id, external, ring_timeout_s, record_calls) values ('e1', '+4312345', 20, 1)`.execute(
    db
  );
  await sql`insert into forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) values ('s1', 't1', 'proj_1', '[]')`.execute(
    db
  );
  await sql`insert into forward_targets (id) values ('h1')`.execute(db);
  await sql`insert into decisions (id, name, default_target_id, created_at) values ('d1', 'Main', 'h1', 't')`.execute(
    db
  );
  await sql`insert into decision_cases (id, decision_id, position, target_id) values ('c1', 'd1', 0, 'e1')`.execute(
    db
  );
  await sql`insert into decision_conditions (id, decision_id, case_id, position, type) values ('k1', 'd1', 'c1', 0, 'callerUser')`.execute(
    db
  );
  await migrateForTest(db);
  expect(
    await db
      .selectFrom('forwardTargets')
      .select(['id', 'external', 'sipUser', 'ringTimeoutS', 'recordCalls'])
      .orderBy('id')
      .execute()
  ).toEqual([
    {
      id: 'e1',
      external: '+4312345',
      sipUser: null,
      ringTimeoutS: 20,
      recordCalls: 1
    },
    {
      id: 'h1',
      external: null,
      sipUser: null,
      ringTimeoutS: null,
      recordCalls: 0
    },
    {
      id: 's1',
      external: null,
      sipUser: 'proj_1',
      ringTimeoutS: null,
      recordCalls: 0
    }
  ]);
  expect(
    await db.selectFrom('decisionConditions').select('type').execute()
  ).toEqual([{ type: 'callerUser' }]);

  // A template in place of a number or a user part, and the kind `extension`.
  for (const row of [
    { id: 'e2', external: '+431{{slice did -2}}', ringTimeoutS: 10 },
    {
      id: 's2',
      sipTrunkId: 't1',
      sipUser: 'q-{{callerNumber}}',
      sipHeadersJson: '[]',
      recordCalls: 1
    },
    { id: 'x1', extension: '{{slice did -2}}' }
  ]) {
    // eslint-disable-next-line no-await-in-loop -- one row after the other, each with its own columns
    await db.insertInto('forwardTargets').values(row).execute();
  }
  const refused = [
    [{ id: 'r1', external: '0043123' }, /forward_targets_external/u],
    [
      { id: 'r2', sipTrunkId: 't1', sipUser: 'a@b', sipHeadersJson: '[]' },
      /forward_targets_sip_user/u
    ],
    [{ id: 'r3', extension: '17' }, /forward_targets_extension/u],
    [
      { id: 'r4', extension: '{{did}}', userId: 'u1' },
      /forward_targets_one_kind/u
    ],
    [
      { id: 'r5', extension: '{{did}}', recordCalls: 1 },
      /forward_targets_record_calls/u
    ],
    [
      { id: 'r6', extension: '{{did}}', ringTimeoutS: 5 },
      /forward_targets_ring_timeout/u
    ]
  ] as const;
  for (const [row, check] of refused) {
    // eslint-disable-next-line no-await-in-loop -- one refusal after the other
    await expect(
      db.insertInto('forwardTargets').values(row).execute()
    ).rejects.toThrow(check);
  }
  const condition = { decisionId: 'd1', caseId: 'c1', parentId: null };
  await db
    .insertInto('decisionConditions')
    .values({
      id: 'k2',
      ...condition,
      position: 1,
      type: 'template',
      valueJson: '{"template":"{{did}}","equals":"+43"}'
    })
    .execute();
  await expect(
    sql`insert into decision_conditions (id, decision_id, case_id, position, type) values ('k3', 'd1', 'c1', 2, 'nope')`.execute(
      db
    )
  ).rejects.toThrow(/decision_conditions_type/u);
  await expect(
    sql`insert into decision_conditions (id, decision_id, case_id, position) values ('k4', 'd1', 'c1', 2)`.execute(
      db
    )
  ).rejects.toThrow(/NOT NULL/u);
  await db.destroy();
});
