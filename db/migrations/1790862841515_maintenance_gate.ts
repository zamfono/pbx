import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// maintenance_gate (§6.4 "Maintenance gate", §11.2): the maintenance gate's last give-up per
// piece of work it holds, the certificate swap and the automatic update, and how many maintenance
// moments in a row it gave up since that work last went through. A new table starts empty; a row
// appears the first time the gate gives up on its work. `IF NOT EXISTS`, so a retry after a
// failure finishes the job.

export async function up(db: Db): Promise<void> {
  await db.schema
    .createTable('maintenance_gate')
    .ifNotExists()
    .addColumn('work', 'text', col =>
      col
        .primaryKey()
        .notNull()
        .check(sql`work in ('certSync','autoUpdate')`)
    )
    .addColumn('gave_up_at', 'text', col => col.notNull())
    .addColumn('reason', 'text', col => col.notNull())
    .addColumn('consecutive_give_ups', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`consecutive_give_ups >= 0`)
    )
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema.dropTable('maintenance_gate').execute();
}
