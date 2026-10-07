import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { migratedTestDb } from './testDb.js';

// trunks.diversion (§9.4 "Forwarded calls", §11.2): a trunk written without the column sends no
// `Diversion` (`diversion` 'off'), and a value outside the three is refused.
test("a new trunk gets diversion 'off'", async () => {
  const db = await migratedTestDb();
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
    sql`update trunks set diversion = 'first' where id = 't-ip'`.execute(db)
  ).rejects.toThrow(/CHECK constraint failed/u);
});

// trunks.forwarded_caller_id (§9.4 "Forwarded calls", §11.2): a trunk written without the column
// presents its own number on forwarded legs ('own'), a value outside the three is refused, and the
// original caller only goes with caller_id_header 'from' and a diversion of 'last' or 'all'.
test("a new trunk gets forwarded_caller_id 'own'", async () => {
  const db = await migratedTestDb();
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, created_at)
            VALUES ('t-ip', 'A', 1, 1, 'ip', 't')`.execute(db);

  const row = await db
    .selectFrom('trunks')
    .select('forwardedCallerId')
    .executeTakeFirstOrThrow();
  expect(row.forwardedCallerId).toBe('own');
  await expect(
    sql`update trunks set forwarded_caller_id = 'original' where id = 't-ip'`.execute(
      db
    )
  ).rejects.toThrow(/CHECK constraint failed/u);
  await sql`update trunks set diversion = 'last', forwarded_caller_id = 'original'
            where id = 't-ip'`.execute(db);
  await sql`update trunks set diversion = 'all', forwarded_caller_id = 'originalPreferred'
            where id = 't-ip'`.execute(db);
  await expect(
    sql`update trunks set diversion = 'off' where id = 't-ip'`.execute(db)
  ).rejects.toThrow(/CHECK constraint failed/u);
  await expect(
    sql`update trunks set caller_id_header = 'both' where id = 't-ip'`.execute(
      db
    )
  ).rejects.toThrow(/CHECK constraint failed/u);
  await expect(
    sql`update trunks set forwarded_caller_id = 'spoofed' where id = 't-ip'`.execute(
      db
    )
  ).rejects.toThrow(/CHECK constraint failed/u);
});
