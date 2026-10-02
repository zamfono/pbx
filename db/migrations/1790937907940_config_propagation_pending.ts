import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// settings.config_propagation_pending (§3.1 "Config propagation", §11.4): set while a config
// propagation failed and none has succeeded since. SQLite's `ADD COLUMN` takes a NOT NULL column
// with a default, so no rebuild is needed; the existing row starts at 0, since `api` renders and
// propagates the whole configuration at its start anyway.

export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('config_propagation_pending', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`config_propagation_pending in (0,1)`)
    )
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .dropColumn('config_propagation_pending')
    .execute();
}
