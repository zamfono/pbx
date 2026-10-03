import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// trunks.diversion (§9.4 "Forwarded calls", §11.2): a trunk written without the column sends no
// `Diversion` (`diversion` 'off'), and a value outside the three is refused.
test("a new trunk gets diversion 'off'", async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, created_at)
            VALUES ('t-ip', 'A', 1, 1, 'ip', 't')`.execute(db);

  const rows = await db
    .selectFrom('trunks')
    .select(['id', 'diversion'])
    .orderBy('id')
    .execute();
  expect(rows).toEqual([{ id: 't-ip', diversion: 'off' }]);
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
