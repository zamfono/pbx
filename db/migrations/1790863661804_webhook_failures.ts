import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// webhooks (§10.6 "Webhooks", §11.2): what a failing hook's deliveries ran into, so its failures
// are logged once per reason and a day, across `api` restarts, and shown with the hook.
// - last_error, last_error_at: the reason of the last delivery that failed, and when
// - failing_since:             when the hook last turned failing; NULL while it is not
// - failed_deliveries:         the deliveries failed since then, 0 while it is not failing
// - last_logged_at:            when its failure was last logged, for the daily reminder
// Every existing hook gets them NULL and 0: one already failing has its next failure logged as a
// change of reason. Kysely runs a SQLite migration outside a transaction, so `up` and `down`
// each open their own.

const TEXT_COLUMNS = [
  'last_error',
  'last_error_at',
  'failing_since',
  'last_logged_at'
];

async function addColumns(db: Db): Promise<void> {
  for (const column of TEXT_COLUMNS) {
    // eslint-disable-next-line no-await-in-loop -- one ALTER TABLE per column, in order
    await db.schema.alterTable('webhooks').addColumn(column, 'text').execute();
  }
  await db.schema
    .alterTable('webhooks')
    .addColumn('failed_deliveries', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`failed_deliveries >= 0`)
    )
    .execute();
}

async function dropColumns(db: Db): Promise<void> {
  for (const column of [...TEXT_COLUMNS, 'failed_deliveries']) {
    // eslint-disable-next-line no-await-in-loop -- one ALTER TABLE per column, in order
    await db.schema.alterTable('webhooks').dropColumn(column).execute();
  }
}

export async function up(db: Db): Promise<void> {
  await db.transaction().execute(addColumns);
}

export async function down(db: Db): Promise<void> {
  await db.transaction().execute(dropColumns);
}
