import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { migratedTestDb } from './testDb.js';

// call_qos.rx_packets and tx_packets (§11.2).
test('takes a count of 0 and refuses a negative one', async () => {
  const db = await migratedTestDb();
  await sql`INSERT INTO calls (id, direction, from_uri, to_uri, status, started_at)
            VALUES ('c1', 'internal', '100', '101', 'answered', 't')`.execute(
    db
  );
  await expect(
    sql`INSERT INTO call_qos (call_id, channel_id, role, rx_packets)
        VALUES ('c1', 'ch-a', 'caller', -1)`.execute(db)
  ).rejects.toThrow(/CHECK constraint/u);
  await sql`INSERT INTO call_qos (call_id, channel_id, role, rx_packets, tx_packets)
            VALUES ('c1', 'ch-a', 'caller', 0, 0)`.execute(db);
  const row = await db
    .selectFrom('callQos')
    .select(['rxPackets', 'txPackets'])
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ rxPackets: 0, txPackets: 0 });
});
