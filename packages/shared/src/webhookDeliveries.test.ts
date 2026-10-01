import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The webhook_deliveries migration (§10.6 "Webhooks", §11.2) on a database that already holds a
// webhook: the outbox starts empty, a hook's purge takes its pending deliveries with it, and the
// migration's down drops the table and leaves the hooks as they were.
test('adds an empty outbox that a purged hook empties, and goes down again', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, '1790780978051_trunk_diversion');
  await sql`INSERT INTO webhooks (id, url, active, secret_enc, created_at)
            VALUES ('h1', 'https://example.test/hook', 1, x'00', 't')`.execute(
    db
  );

  await migrateForTest(db);

  expect(
    await db.selectFrom('webhookDeliveries').selectAll().execute()
  ).toEqual([]);
  await db
    .insertInto('webhookDeliveries')
    .values({
      id: 'd1',
      webhookId: 'h1',
      bodyJson: '{}',
      nextAttemptAt: 't',
      createdAt: 't'
    })
    .execute();
  const [row] = await db
    .selectFrom('webhookDeliveries')
    .select('attempts')
    .execute();
  expect(row?.attempts).toBe(0);
  await db.deleteFrom('webhooks').where('id', '=', 'h1').execute();
  expect(
    await db.selectFrom('webhookDeliveries').selectAll().execute()
  ).toEqual([]);

  await sql`INSERT INTO webhooks (id, url, active, secret_enc, created_at)
            VALUES ('h2', 'https://example.test/hook', 1, x'00', 't')`.execute(
    db
  );
  await migrateForTest(db, '1790780978051_trunk_diversion');
  const tables = (await db.introspection.getTables()).map(table => table.name);
  expect(tables).not.toContain('webhook_deliveries');
  expect(await db.selectFrom('webhooks').select('id').execute()).toEqual([
    { id: 'h2' }
  ]);
});
