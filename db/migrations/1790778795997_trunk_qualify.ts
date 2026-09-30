import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// trunks.qualify (§9.4 "Provisioning and status", §11.2): whether an `ip` trunk's contact is
// OPTIONS-probed for its status. SQLite's `ADD COLUMN` takes a NOT NULL column with a default and
// a CHECK, so no rebuild is needed. It is added at 1, the value a new trunk gets, which every
// existing trunk keeps: each was probed before this migration, so its status behaves exactly as
// it did. A single statement, so nothing is left half-done for a retry to trip over.

export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('trunks')
    .addColumn('qualify', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`qualify in (0,1)`)
    )
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema.alterTable('trunks').dropColumn('qualify').execute();
}
