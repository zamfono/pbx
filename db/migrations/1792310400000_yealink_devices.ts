import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// devices.kind — a third kind, `yealink`, a desk phone provisioned from a link (§10.4), always
// `tls` like `ringotel`. The kind's CHECK is the column's own, which SQLite cannot change, so
// the column is replaced by one with the wider CHECK, its values copied; the CHECK and the index
// that name the column go first and come back after.
async function addYealinkKind(db: Db): Promise<void> {
  await db.schema.dropIndex('devices_one_ringotel_per_user').execute();
  await db.schema
    .alterTable('devices')
    .dropConstraint('devices_manual_or_tls')
    .execute();
  await db.schema
    .alterTable('devices')
    .addColumn('kind_next', 'text', col =>
      col.check(sql`kind_next in ('manual','ringotel','yealink')`)
    )
    .execute();
  await sql`UPDATE devices SET kind_next = kind`.execute(db);
  await db.schema
    .alterTable('devices')
    .alterColumn('kind_next', col => col.setNotNull())
    .execute();
  await db.schema.alterTable('devices').dropColumn('kind').execute();
  await db.schema
    .alterTable('devices')
    .renameColumn('kind_next', 'kind')
    .execute();
  await db.schema
    .alterTable('devices')
    .addCheckConstraint(
      'devices_manual_or_tls',
      sql`kind = 'manual' or transport = 'tls'`
    )
    .execute();
  await db.schema
    .createIndex('devices_one_ringotel_per_user')
    .on('devices')
    .unique()
    .column('user_id')
    .where(sql.ref('kind'), '=', 'ringotel')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// devices — a `yealink` device's provisioning (§10.4 "`yealink`", §11.2): its ringtone, the
// SHA-256 of its link's token and the phone's admin password, both set when it is created, and the
// time and client address of the latest answered fetch. Only a `yealink` device has any.
async function addDeviceProvisioningColumns(db: Db): Promise<void> {
  await db.schema.alterTable('devices').addColumn('ringtone', 'text').execute();
  await db.schema
    .alterTable('devices')
    .addColumn('provisioning_token_hash', 'text')
    .execute();
  await db.schema
    .alterTable('devices')
    .addColumn('admin_password_enc', 'blob')
    .execute();
  await db.schema
    .alterTable('devices')
    .addColumn('provisioned_at', 'text')
    .execute();
  await db.schema
    .alterTable('devices')
    .addColumn('provisioned_from', 'text')
    .execute();
  await db.schema
    .alterTable('devices')
    .addCheckConstraint(
      'devices_yealink_provisioning',
      sql`(kind = 'yealink') = (provisioning_token_hash is not null)
            and (kind = 'yealink') = (admin_password_enc is not null)
            and (kind = 'yealink' or ringtone is null)`
    )
    .execute();
  await db.schema
    .createIndex('devices_provisioning_token_hash')
    .on('devices')
    .unique()
    .column('provisioning_token_hash')
    .execute();
}

// device_blf_keys — a key is one of five kinds, each in a column of its own (§11.2): a BLF key
// on an extension (`ext`, the kind it held so far), and on a `yealink` device a quick-dial key
// (`number`), a feature key (`feature`), a mailbox key (`mailbox_ext`) or the account's line key
// (`is_line_key`, at most one per device); the last three but the line key carry a label. Keyed by
// position, since `ext` may be NULL. SQLite cannot change a primary key, so the table is rebuilt
// with its rows; nothing references it.
async function addKeyKinds(db: Db): Promise<void> {
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
            (mailbox_ext is not null) + is_line_key = 1`
    )
    .addCheckConstraint(
      'device_blf_keys_label',
      sql`(label is not null) =
            (number is not null or feature is not null or mailbox_ext is not null)`
    )
    .execute();
  await sql`INSERT INTO device_blf_keys_next (device_id, position, ext) SELECT device_id, position, ext FROM device_blf_keys`.execute(
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

export async function up(db: Db): Promise<void> {
  await addYealinkKind(db);
  await addDeviceProvisioningColumns(db);
  await addKeyKinds(db);
}
