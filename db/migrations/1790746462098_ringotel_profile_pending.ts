import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// settings.ringotel_profile_pending (§10.4 "Tenant profile push", §11.4): set while a change to
// the tenant's Ringotel profile, its emergency numbers among them, has not reached Ringotel yet.
// SQLite's `ADD COLUMN` takes a NOT NULL column with a default, so no rebuild is needed; the
// existing row starts at 0, since every push before this migration ran inside its operation and
// failed that operation rather than leaving anything behind.

export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('ringotel_profile_pending', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`ringotel_profile_pending in (0,1)`)
    )
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .dropColumn('ringotel_profile_pending')
    .execute();
}
