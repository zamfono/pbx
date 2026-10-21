import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// device_blf_keys — a sixth kind, a `yealink` device's empty key (`is_empty`), which leaves its
// line key unset so the keys after it move further along (§10.4, §11.2). SQLite cannot change a
// CHECK, so the table is rebuilt with its rows; nothing references it.
export async function up(db: Db): Promise<void> {
  await db.schema
    .createTable('device_blf_keys_next')
    .addColumn('device_id', 'text', col =>
      col.notNull().references('devices.id').onDelete('cascade')
    )
    .addColumn('position', 'integer', col => col.notNull())
    .addColumn('ext', 'text', col =>
      col.references('extensions.ext').onDelete('cascade')
    )
    .addColumn('number', 'text')
    .addColumn('feature', 'text', col =>
      col.check(sql`feature in ('dndToggle','ownVoicemail','park')`)
    )
    .addColumn('mailbox_ext', 'text', col =>
      col.references('extensions.ext').onDelete('cascade')
    )
    .addColumn('is_line_key', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`is_line_key in (0,1)`)
    )
    .addColumn('is_empty', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`is_empty in (0,1)`)
    )
    .addColumn('label', 'text')
    .addPrimaryKeyConstraint('device_blf_keys_pk', ['device_id', 'position'])
    .addUniqueConstraint('device_blf_keys_ext_unique', ['device_id', 'ext'])
    .addUniqueConstraint('device_blf_keys_mailbox_unique', [
      'device_id',
      'mailbox_ext'
    ])
    .addCheckConstraint(
      'device_blf_keys_one_kind',
      sql`(ext is not null) + (number is not null) + (feature is not null) +
            (mailbox_ext is not null) + is_line_key + is_empty = 1`
    )
    .addCheckConstraint(
      'device_blf_keys_label',
      sql`(label is not null) =
            (number is not null or feature is not null or mailbox_ext is not null)`
    )
    .execute();
  await sql`INSERT INTO device_blf_keys_next (device_id, position, ext, number, feature, mailbox_ext, is_line_key, label)
    SELECT device_id, position, ext, number, feature, mailbox_ext, is_line_key, label FROM device_blf_keys`.execute(
    db
  );
  await db.schema.dropTable('device_blf_keys').execute();
  await db.schema
    .alterTable('device_blf_keys_next')
    .renameTo('device_blf_keys')
    .execute();
  await db.schema
    .createIndex('device_blf_keys_one_line_key')
    .on('device_blf_keys')
    .unique()
    .column('device_id')
    .where(sql.ref('is_line_key'), '=', 1)
    .execute();
}
