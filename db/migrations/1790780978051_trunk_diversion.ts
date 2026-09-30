import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// trunks.diversion (§9.4 "Forwarded calls", §11.2): the `Diversion` a forwarded leg over the
// trunk carries, 'off', 'last' or 'all'. SQLite's `ADD COLUMN` takes a NOT NULL column with a
// default and a CHECK, so no rebuild is needed. It is added at 'off', the value a new trunk gets,
// which every existing trunk takes too: the last release sent no `Diversion` at all, so a trunk
// behaves as it did there until an admin opts it in. A single statement, so nothing is left
// half-done for a retry to trip over.

export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('trunks')
    .addColumn('diversion', 'text', col =>
      col
        .notNull()
        .defaultTo('off')
        .check(sql`diversion in ('off','last','all')`)
    )
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema.alterTable('trunks').dropColumn('diversion').execute();
}
