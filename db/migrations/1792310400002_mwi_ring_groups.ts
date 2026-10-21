import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// A device's message indicator (§9.3 "MWI", §11.2): `devices.mwi_all_ring_groups` 1 counts the
// user's own mailbox and every ring group's they belong to, as every device did so far; 0 counts
// the own mailbox and the groups of `device_mwi_ring_groups` alone, which holds rows only then.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('devices')
    .addColumn('mwi_all_ring_groups', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`mwi_all_ring_groups in (0,1)`)
    )
    .execute();
  await db.schema
    .createTable('device_mwi_ring_groups')
    .addColumn('device_id', 'text', col =>
      col.notNull().references('devices.id').onDelete('cascade')
    )
    .addColumn('ring_group_id', 'text', col =>
      col.notNull().references('ring_groups.id').onDelete('cascade')
    )
    .addPrimaryKeyConstraint('device_mwi_ring_groups_pk', [
      'device_id',
      'ring_group_id'
    ])
    .execute();
  await db.schema
    .createIndex('device_mwi_ring_groups_ring_group')
    .on('device_mwi_ring_groups')
    .column('ring_group_id')
    .execute();
}
