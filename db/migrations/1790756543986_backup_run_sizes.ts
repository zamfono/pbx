import type { Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// backup_runs.bytes_added and bytes_total (§6.5, §11.2): a run records both what it uploaded after
// deduplication (restic's `data_added`) and the snapshot's full size (`total_bytes_processed`).
// `bytes` always held `data_added`, so it is renamed; SQLite's `RENAME COLUMN` and a nullable
// `ADD COLUMN` need no rebuild. An existing run's total was never recorded and stays NULL.

export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('backup_runs')
    .renameColumn('bytes', 'bytes_added')
    .execute();
  await db.schema
    .alterTable('backup_runs')
    .addColumn('bytes_total', 'integer')
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema.alterTable('backup_runs').dropColumn('bytes_total').execute();
  await db.schema
    .alterTable('backup_runs')
    .renameColumn('bytes_added', 'bytes')
    .execute();
}
