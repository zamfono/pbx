import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

/** The hop limit before it was a setting (§10.1 step 7). */
const DEFAULT_MAX_FORWARD_HOPS = 3;

// forward_targets — an `external`, `sip` or `webSocket` target's fallback (§10.1 step 7): the row
// a target's `fallback_of_id` names is the one it stands in for once that one does not work, at
// most one per target (the unique index), and goes with it (`ON DELETE CASCADE`), so a chain is
// owned by the column owning its first row. `ring_timeout_s`, on an `external` or `sip` target,
// is how long it rings before it counts as not working, at most a day as every timeout (§11.2).
// settings.max_forward_hops — the hop limit (§10.1 step 7), 3 before it was a setting.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .addColumn('fallback_of_id', 'text', col =>
      col.references('forward_targets.id').onDelete('cascade')
    )
    .execute();
  await db.schema
    .createIndex('forward_targets_fallback_of_id')
    .unique()
    .on('forward_targets')
    .column('fallback_of_id')
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addColumn('ring_timeout_s', 'integer', col =>
      col.check(
        sql`ring_timeout_s is null or (ring_timeout_s between 1 and 86400 and (external is not null or sip_trunk_id is not null))`
      )
    )
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('max_forward_hops', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_MAX_FORWARD_HOPS)
        .check(sql`max_forward_hops >= 1`)
    )
    .execute();
}
