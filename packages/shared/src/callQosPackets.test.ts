import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The call_qos_packets migration (§11.2) on a database that already holds QoS rows: each keeps its
// figures, and the packet counts nobody recorded are NULL, not 0.
test('keeps an existing row’s figures, rx_packets and tx_packets NULL', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, '1790770935482_forward_target_sip');
  await sql`INSERT INTO calls (id, direction, from_uri, to_uri, status, started_at, ended_at)
            VALUES ('c1', 'internal', '100', '101', 'answered', 't', 't')`.execute(
    db
  );
  await sql`INSERT INTO call_qos (call_id, channel_id, role, jitter_ms, loss_pct, rtt_ms)
            VALUES ('c1', 'ch-a', 'caller', 3.4, 0.5, 42),
                   ('c1', 'ch-b', 'callee', NULL, NULL, NULL)`.execute(db);

  await migrateForTest(db);

  const rows = await db
    .selectFrom('callQos')
    .selectAll()
    .orderBy('channelId')
    .execute();
  expect(rows).toEqual([
    {
      callId: 'c1',
      channelId: 'ch-a',
      role: 'caller',
      jitterMs: 3.4,
      lossPct: 0.5,
      rttMs: 42,
      rxPackets: null,
      txPackets: null
    },
    {
      callId: 'c1',
      channelId: 'ch-b',
      role: 'callee',
      jitterMs: null,
      lossPct: null,
      rttMs: null,
      rxPackets: null,
      txPackets: null
    }
  ]);
});

test('takes a count of 0 and refuses a negative one', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
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
