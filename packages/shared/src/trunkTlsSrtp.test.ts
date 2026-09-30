import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The trunk_tls_srtp migration (§9.4 "Signaling", §11.2) on a database that already holds
// trunks: an existing TLS trunk keeps today's unverified connection (`tls_verify` 0), every other
// trunk and every new one gets 1, and no trunk starts with SRTP.
test('an existing TLS trunk gets tls_verify 0, the others and a new one 1, srtp 0 throughout', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, '1790756543986_backup_run_sizes');
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t-tls', 'A', 1, 1, 'ip', 'tls', 't'),
                   ('t-udp', 'B', 2, 1, 'ip', 'udp', 't')`.execute(db);

  await migrateForTest(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, created_at)
            VALUES ('t-new', 'C', 3, 1, 'ip', 'tls', 't')`.execute(db);

  const rows = await db
    .selectFrom('trunks')
    .select(['id', 'srtp', 'tlsVerify'])
    .orderBy('id')
    .execute();
  expect(rows).toEqual([
    { id: 't-new', srtp: 0, tlsVerify: 1 },
    { id: 't-tls', srtp: 0, tlsVerify: 0 },
    { id: 't-udp', srtp: 0, tlsVerify: 1 }
  ]);
});

test('srtp is refused on a trunk whose transport is not tls', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, srtp, created_at)
            VALUES ('t-tls', 'A', 1, 1, 'ip', 'tls', 1, 't')`.execute(db);
  await expect(
    sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, transport, srtp, created_at)
        VALUES ('t-udp', 'B', 2, 1, 'ip', 'udp', 1, 't')`.execute(db)
  ).rejects.toThrow(/CHECK constraint failed/u);
  await expect(
    db
      .updateTable('trunks')
      .set({ transport: 'tcp' })
      .where('id', '=', 't-tls')
      .execute()
  ).rejects.toThrow(/CHECK constraint failed/u);
});
