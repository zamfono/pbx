import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// trunks.srtp (§9.4 "Signaling", §11.2).
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
