import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { migratedTestDb, seedSettings, seedUser } from './testDb.js';

// Every seconds-valued timeout is at most a day (§11.1), so no timer it starts overflows.
test('a timeout above 86400 seconds is refused, 86400 is kept', async () => {
  const db = await migratedTestDb();
  await seedSettings(db);
  await seedUser(db, { id: 'u1' });
  await sql`INSERT INTO ring_groups (id, name, strategy, created_at)
            VALUES ('g1', 'G', 'sequential', 't')`.execute(db);
  await sql`INSERT INTO audio_assets (id, label, kind, filename, created_at)
            VALUES ('a1', 'A', 'announcement', 'a.wav', 't')`.execute(db);
  await sql`INSERT INTO forward_targets (id, external) VALUES ('f1', '+431')`.execute(
    db
  );
  await sql`INSERT INTO menus (id, name, audio_id, fallback_target_id, created_at)
            VALUES ('m1', 'M', 'a1', 'f1', 't')`.execute(db);
  await sql`INSERT INTO trunks (id, name, priority, emergency, auth_mode, username,
                                password_enc, created_at)
            VALUES ('t1', 'T', 1, 1, 'registration', 'u', 'p', 't')`.execute(
    db
  );
  const columns = [
    ['users', 'ring_timeout_s'],
    ['ring_groups', 'ring_timeout_s'],
    ['ring_groups', 'ring_total_s'],
    ['menus', 'timeout_s'],
    ['settings', 'voicemail_max_s'],
    ['settings', 'parking_timeout_s'],
    ['trunks', 'register_expiry_s'],
    ['trunks', 'register_retry_s']
  ] as const;

  // Each column is checked on its own, so the checks may run side by side.
  await Promise.all(
    columns.map(async ([table, column]) => {
      const set = (seconds: number) =>
        sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${seconds}`.execute(
          db
        );
      await expect(set(86_401), `${table}.${column}`).rejects.toThrow(
        /CHECK constraint failed/u
      );
      await expect(set(86_400), `${table}.${column}`).resolves.toBeDefined();
    })
  );
});
