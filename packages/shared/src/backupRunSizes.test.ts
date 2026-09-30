import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';
import { migrateForTest } from './testDb.js';

// The backup_run_sizes migration (§11.2) on a database that already holds runs: `bytes` was
// restic's `data_added`, so it carries over as `bytes_added`, and the total nobody recorded is NULL.
test('keeps an existing run’s bytes as bytes_added, bytes_total NULL', async () => {
  const db = openDb(':memory:');
  await migrateForTest(db, '1790746462098_ringotel_profile_pending');
  await sql`INSERT INTO backup_targets (id, kind, params_json, secret_enc, created_at)
            VALUES ('t1', 'local', '{}', x'00', 't')`.execute(db);
  await sql`INSERT INTO backup_runs (id, target_id, status, snapshot_id, bytes, started_at, finished_at)
            VALUES ('r1', 't1', 'ok', 'snap', 580000, 't', 't'),
                   ('r2', 't1', 'failed', NULL, NULL, 't', 't')`.execute(db);

  await migrateForTest(db);

  const rows = await db
    .selectFrom('backupRuns')
    .select(['id', 'bytesAdded', 'bytesTotal'])
    .orderBy('id')
    .execute();
  expect(rows).toEqual([
    { id: 'r1', bytesAdded: 580000, bytesTotal: null },
    { id: 'r2', bytesAdded: null, bytesTotal: null }
  ]);
});
