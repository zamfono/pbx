import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The trunk_diversion migration (§9.4 "Forwarded calls", §11.2) on a database that already holds
// trunks: every existing trunk sends no `Diversion` (`diversion` 'off'), as the last release did,
// as does a new one written without the column, and a value outside the three is refused.
test("existing trunks and a new one get diversion 'off'", async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, '1790778795997_trunk_qualify');
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t-ip', 'A', 1, 1, 'ip', 'udp', 't')`.execute(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, username, password_enc, created_at)
            VALUES ('t-reg', 'B', 2, 1, 'registration', 'u', x'00', 't')`.execute(
    db
  );

  await migrateForTest(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, created_at)
            VALUES ('t-new', 'C', 3, 1, 'ip', 't')`.execute(db);

  const rows = await db
    .selectFrom('trunks')
    .select(['id', 'diversion'])
    .orderBy('id')
    .execute();
  expect(rows).toEqual([
    { id: 't-ip', diversion: 'off' },
    { id: 't-new', diversion: 'off' },
    { id: 't-reg', diversion: 'off' }
  ]);
  await db
    .updateTable('trunks')
    .set({ diversion: 'all' })
    .where('id', '=', 't-ip')
    .execute();
  await expect(
    db
      .updateTable('trunks')
      .set({ diversion: 'first' })
      .where('id', '=', 't-ip')
      .execute()
  ).rejects.toThrow(/CHECK constraint failed/u);
});
