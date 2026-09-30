import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb, type Db } from './db.js';
import { migrateForTest } from './testDb.js';

const BEFORE = '1790768252101_trunk_tls_srtp';

/** One row of each of the seven earlier target kinds, each held by one of the nine owner columns
 * (§11.2 `forward_targets`), in a database migrated up to the migration before the rebuild. */
async function populate(db: Db): Promise<void> {
  await sql`INSERT INTO users (id, name, email, created_at) VALUES ('u1', 'Anna', 'a@x.test', 't')`.execute(
    db
  );
  await sql`INSERT INTO ring_groups (id, name, strategy, created_at) VALUES ('g1', 'G', 'simultaneous', 't')`.execute(
    db
  );
  await sql`INSERT INTO audio_assets (id, label, kind, filename, created_at) VALUES ('a1', 'A', 'announcement', 'a.wav', 't')`.execute(
    db
  );
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t1', 'T', 1, 1, 'ip', 'tls', 't')`.execute(db);
  await sql`INSERT INTO forward_targets (id, user_id, ring_group_id, external, mailbox_user_id,
              mailbox_ring_group_id, announcement_audio_id, menu_id)
            VALUES ('ft-user', 'u1', NULL, NULL, NULL, NULL, NULL, NULL),
                   ('ft-group', NULL, 'g1', NULL, NULL, NULL, NULL, NULL),
                   ('ft-ext', NULL, NULL, '+4312345', NULL, NULL, NULL, NULL),
                   ('ft-mbu', NULL, NULL, NULL, 'u1', NULL, NULL, NULL),
                   ('ft-mbg', NULL, NULL, NULL, NULL, 'g1', NULL, NULL),
                   ('ft-ann', NULL, NULL, NULL, NULL, NULL, 'a1', NULL),
                   ('ft-fallback', NULL, NULL, NULL, NULL, NULL, 'a1', NULL)`.execute(
    db
  );
  await sql`INSERT INTO menus (id, name, audio_id, fallback_target_id, created_at)
            VALUES ('m1', 'M', 'a1', 'ft-fallback', 't')`.execute(db);
  await sql`INSERT INTO forward_targets (id, menu_id) VALUES ('ft-menu', 'm1')`.execute(
    db
  );
  await sql`INSERT INTO dids (id, number, target_id, created_at) VALUES ('d1', '+4311', 'ft-menu', 't')`.execute(
    db
  );
  await sql`INSERT INTO user_forward_rules (user_id, condition, target_id) VALUES ('u1', 'busy', 'ft-ext')`.execute(
    db
  );
  await sql`INSERT INTO ring_group_forward_rules (group_id, condition, target_id) VALUES ('g1', 'unanswered', 'ft-mbg')`.execute(
    db
  );
  await sql`INSERT INTO menu_targets (menu_id, digits, target_id) VALUES ('m1', '1', 'ft-user')`.execute(
    db
  );
  await sql`INSERT INTO ooo_rules (id, scope_user_id, target_id, created_at) VALUES ('o1', 'u1', 'ft-mbu', 't')`.execute(
    db
  );
  await sql`INSERT INTO opening_hours (id, scope_ring_group_id, closed_target_id, created_at) VALUES ('h1', 'g1', 'ft-group', 't')`.execute(
    db
  );
  await sql`INSERT INTO did_blocks (id, base, fallback_target_id, created_at) VALUES ('b1', '+4312', 'ft-ann', 't')`.execute(
    db
  );
}

// The forward_target_sip rebuild (§9.4 "SIP targets", §11.2) on a database that holds a target of
// every earlier kind: each row keeps its id and columns, every owner still reaches its target,
// and the foreign keys hold both ways.
test('every earlier target kind survives the rebuild, its owners still pointing at it', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, BEFORE);
  await populate(db);
  const before = await sql<
    Record<string, unknown>
  >`SELECT * FROM forward_targets ORDER BY id`.execute(db);

  await migrateForTest(db, '1790770935482_forward_target_sip');

  const after = await sql<
    Record<string, unknown>
  >`SELECT * FROM forward_targets ORDER BY id`.execute(db);
  expect(after.rows).toEqual(
    before.rows.map(row => ({ ...row, sipTrunkId: null, sipUser: null }))
  );
  const { rows: dangling } = await sql`PRAGMA foreign_key_check`.execute(db);
  expect(dangling).toEqual([]);
  const { rows: fk } = await sql`PRAGMA foreign_keys`.execute(db);
  expect(fk).toEqual([{ foreignKeys: 1 }]);
  // The owner columns still restrict a delete of what they reference, now on the new table.
  await expect(
    sql`DELETE FROM forward_targets WHERE id = 'ft-menu'`.execute(db)
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  await expect(
    sql`DELETE FROM users WHERE id = 'u1'`.execute(db)
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
});

test('a sip target sets both columns, names a trunk it keeps, and a safe user part', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t1', 'T', 1, 1, 'ip', 'tls', 't')`.execute(db);
  await sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('ft-sip', 't1', 'proj_Ab.c~1+2-3')`.execute(
    db
  );
  await expect(
    sql`DELETE FROM trunks WHERE id = 't1'`.execute(db)
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  const refused = [
    sql`INSERT INTO forward_targets (id, sip_trunk_id) VALUES ('x1', 't1')`,
    sql`INSERT INTO forward_targets (id, external, sip_user) VALUES ('x2', '+431', 'a')`,
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, external) VALUES ('x3', 't1', 'a', '+431')`,
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('x4', 't1', 'a@b')`,
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('x5', 't1', '')`,
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('x6', 't1', ${'a'.repeat(65)})`
  ];
  for (const statement of refused) {
    // eslint-disable-next-line no-await-in-loop -- each statement is refused on its own
    await expect(statement.execute(db)).rejects.toThrow(
      /CHECK constraint failed/u
    );
  }
  await expect(
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user) VALUES ('x7', 'nope', 'a')`.execute(
      db
    )
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
});
