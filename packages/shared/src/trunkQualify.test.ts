import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// trunks.qualify (§9.4 "Provisioning and status", §11.2): a trunk written without the column
// keeps its OPTIONS probe (`qualify` 1), and a value other than 0 or 1 is refused.
test('a new trunk gets qualify 1', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, created_at)
            VALUES ('t-ip', 'A', 1, 1, 'ip', 't')`.execute(db);

  const rows = await db
    .selectFrom('trunks')
    .select(['id', 'qualify'])
    .orderBy('id')
    .execute();
  expect(rows).toEqual([{ id: 't-ip', qualify: 1 }]);
  await expect(
    db
      .updateTable('trunks')
      .set({ qualify: 2 })
      .where('id', '=', 't-ip')
      .execute()
  ).rejects.toThrow(/CHECK constraint failed/u);
});
