import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// forward_targets — whether an `external` or `sip` target records the trunk leg it answers on, an
// admin-set flag no other kind takes (§10.2 "Recording semantics", §11.2).
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .addColumn('record_calls', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(
          sql`record_calls in (0,1) and (record_calls = 0 or external is not null or sip_trunk_id is not null)`
        )
    )
    .execute();
}
