import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// webhook_deliveries (§10.6 "Webhooks", §11.2): the outbox starts empty, a delivery starts at
// attempt 0, and a hook's purge takes its pending deliveries with it.
test('starts an empty outbox that a purged hook empties', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await sql`INSERT INTO webhooks (id, url, active, secret_enc, created_at)
            VALUES ('h1', 'https://example.test/hook', 1, x'00', 't')`.execute(
    db
  );

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
});
