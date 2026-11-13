import { randomUUIDv7 } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// sip_bans.protocol — a ban is per transport class, `udp` or `tcp` (TCP and TLS) (§5.6). Every
// existing row banned both, so it becomes one row per protocol: itself as `udp` and a copy as
// `tcp`, so an active ban keeps blocking both and an ended one escalates either's next ban. SQLite
// cannot add a NOT NULL column without a default, so the table is rebuilt; nothing references it.
export async function up(db: Db): Promise<void> {
  await db.schema
    .createTable('sip_bans_next')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('address', 'text', col =>
      col
        .notNull()
        .check(sql`address <> '' and address not glob '*[^0-9a-f.:/]*'`)
    )
    .addColumn('protocol', 'text', col =>
      col.notNull().check(sql`protocol in ('udp','tcp')`)
    )
    .addColumn('step', 'integer', col => col.notNull().check(sql`step >= 1`))
    .addColumn('failures', 'integer', col =>
      col.notNull().check(sql`failures > 0`)
    )
    .addColumn('lifted_by', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('expires_at', 'text')
    .addColumn('lifted_at', 'text')
    .addCheckConstraint(
      'sip_bans_expires_after_created',
      sql`expires_at is null or expires_at > created_at`
    )
    .addCheckConstraint(
      'sip_bans_lifted_by_needs_lifted_at',
      sql`lifted_by is null or lifted_at is not null`
    )
    .execute();
  const rows = await db.selectFrom('sip_bans').selectAll().execute();
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- one ban's two rows after the other's
    await db
      .insertInto('sip_bans_next')
      .values([
        { ...row, protocol: 'udp' },
        { ...row, id: randomUUIDv7(), protocol: 'tcp' }
      ])
      .execute();
  }
  await db.schema.dropTable('sip_bans').execute();
  await db.schema.alterTable('sip_bans_next').renameTo('sip_bans').execute();
}
