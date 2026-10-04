import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { type Db } from './db.js';
import { migratedTestDb } from './testDb.js';

// The sip target kind of forward_targets (§9.4 "SIP targets", §11.2).
async function withTrunk(): Promise<Db> {
  const db = await migratedTestDb();
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t1', 'T', 1, 1, 'ip', 'tls', 't')`.execute(db);
  return db;
}

test.each([
  [
    'a trunk without a user part',
    sql`INSERT INTO forward_targets (id, sip_trunk_id) VALUES ('x1', 't1')`
  ],
  [
    'a user part without a trunk',
    sql`INSERT INTO forward_targets (id, external, sip_user) VALUES ('x2', '+431', 'a')`
  ],
  [
    'a sip target that is also external',
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json, external) VALUES ('x3', 't1', 'a', '[]', '+431')`
  ],
  [
    'an unsafe user part',
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) VALUES ('x4', 't1', 'a@b', '[]')`
  ],
  [
    'an empty user part',
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) VALUES ('x5', 't1', '', '[]')`
  ],
  [
    'a user part over 64 characters',
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) VALUES ('x6', 't1', ${'a'.repeat(65)}, '[]')`
  ]
])('a sip target refuses %s', async (label, statement) => {
  const db = await withTrunk();
  await expect(statement.execute(db)).rejects.toThrow(
    /CHECK constraint failed/u
  );
});

test('a sip target names a trunk it keeps, and a safe user part', async () => {
  const db = await withTrunk();
  await sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) VALUES ('ft-sip', 't1', 'proj_Ab.c~1+2-3', '[]')`.execute(
    db
  );
  await expect(
    sql`DELETE FROM trunks WHERE id = 't1'`.execute(db)
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  await expect(
    sql`INSERT INTO forward_targets (id, sip_trunk_id, sip_user, sip_headers_json) VALUES ('x7', 'nope', 'a', '[]')`.execute(
      db
    )
  ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
});
