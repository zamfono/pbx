import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The sip target kind of forward_targets (§9.4 "SIP targets", §11.2).
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
