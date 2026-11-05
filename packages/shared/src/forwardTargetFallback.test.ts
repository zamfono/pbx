import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { migratedTestDb } from './testDb.js';

// forward_targets.fallback_of_id and ring_timeout_s, settings.max_forward_hops (§10.1 step 7, §11.2).

test('a fallback chain goes with the row it starts at', async () => {
  const db = await migratedTestDb();
  await sql`INSERT INTO forward_targets (id, external) VALUES ('f1', '+431')`.execute(
    db
  );
  await sql`INSERT INTO forward_targets (id, external, fallback_of_id) VALUES ('f2', '+432', 'f1')`.execute(
    db
  );
  await sql`INSERT INTO forward_targets (id, external, fallback_of_id) VALUES ('f3', '+433', 'f2')`.execute(
    db
  );
  await sql`DELETE FROM forward_targets WHERE id = 'f1'`.execute(db);
  const { rows } = await sql<{
    id: string;
  }>`SELECT id FROM forward_targets WHERE id IN ('f1', 'f2', 'f3')`.execute(db);
  expect(rows).toEqual([]);
});

test('a target has at most one fallback', async () => {
  const db = await migratedTestDb();
  await sql`INSERT INTO forward_targets (id, external) VALUES ('f1', '+431')`.execute(
    db
  );
  await sql`INSERT INTO forward_targets (id, external, fallback_of_id) VALUES ('f2', '+432', 'f1')`.execute(
    db
  );
  await expect(
    sql`INSERT INTO forward_targets (id, external, fallback_of_id) VALUES ('f3', '+433', 'f1')`.execute(
      db
    )
  ).rejects.toThrow(/UNIQUE constraint failed/u);
});

test.each([
  [
    'on a kind that is no dial',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate, ring_timeout_s) VALUES ('t1', 'twilio', 'wss://bot.example/a', 8000, 10)`
  ],
  [
    'of zero seconds',
    sql`INSERT INTO forward_targets (id, external, ring_timeout_s) VALUES ('t2', '+431', 0)`
  ],
  [
    'of more than a day',
    sql`INSERT INTO forward_targets (id, external, ring_timeout_s) VALUES ('t3', '+431', 86401)`
  ]
])('refuses a ring timeout %s', async (label, statement) => {
  const db = await migratedTestDb();
  await expect(statement.execute(db)).rejects.toThrow(
    /CHECK constraint failed/u
  );
});

test('the hop limit is 3 unless set', async () => {
  const db = await migratedTestDb();
  const { rows } = await sql<{
    hops: string;
  }>`SELECT dflt_value AS hops FROM pragma_table_info('settings') WHERE name = 'max_forward_hops'`.execute(
    db
  );
  expect(rows).toEqual([{ hops: '3' }]);
});
