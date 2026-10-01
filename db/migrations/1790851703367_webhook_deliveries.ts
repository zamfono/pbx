import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// webhook_deliveries (§10.6 "Webhooks", §11.2): the webhook outbox, one row per hook and event
// until it is delivered or given up, so a queued or retrying delivery survives an `api` restart.
// A new table starts empty. Both statements are `IF NOT EXISTS`, so a retry after a failure
// between them finishes the job instead of tripping over the half that already ran.

export async function up(db: Db): Promise<void> {
  await db.schema
    .createTable('webhook_deliveries')
    .ifNotExists()
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('webhook_id', 'text', col =>
      col.notNull().references('webhooks.id').onDelete('cascade')
    )
    .addColumn('body_json', 'text', col => col.notNull())
    .addColumn('attempts', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`attempts >= 0`)
    )
    .addColumn('next_attempt_at', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .execute();
  await db.schema
    .createIndex('webhook_deliveries_webhook')
    .ifNotExists()
    .on('webhook_deliveries')
    .column('webhook_id')
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema.dropTable('webhook_deliveries').execute();
}
