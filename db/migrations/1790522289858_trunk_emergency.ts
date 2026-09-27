import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// trunks.emergency (§9.4 "Emergency trunks", §10.1 "Emergency calls", §11.2): only a flagged
// trunk carries emergency calls. §11.2 gives the column no default, since the API always
// supplies the admin's explicit choice, and SQLite's `ADD COLUMN` cannot add a NOT NULL column
// without one, so the table is rebuilt the way SQLite documents for a schema change `ALTER
// TABLE` cannot make: a new table, the rows copied, the old one dropped, the new one renamed.
// Every existing trunk gets 1: each carried emergency calls before this migration.

/** `trunks` as the initial migration creates it, plus `emergency` after `priority` (§11.2). */
async function createTrunksNew(db: Db): Promise<void> {
  await db.schema
    .createTable('trunks_new')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('priority', 'integer', col =>
      col.notNull().check(sql`priority >= 1`)
    )
    .addColumn('emergency', 'integer', col =>
      col.notNull().check(sql`emergency in (0,1)`)
    )
    .addColumn('auth_mode', 'text', col =>
      col.notNull().check(sql`auth_mode in ('registration','ip')`)
    )
    .addColumn('username', 'text')
    .addColumn('password_enc', 'blob')
    .addColumn('inbound_auth', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`inbound_auth in (0,1)`)
    )
    .addColumn('transport', 'text', col =>
      col
        .notNull()
        .defaultTo('udp')
        .check(sql`transport in ('udp','tcp','tls')`)
    )
    .addColumn('outbound_proxy', 'text')
    .addColumn('register_expiry_s', 'integer')
    .addColumn('register_retry_s', 'integer')
    .addColumn('inbound_number_format', 'text', col =>
      col
        .notNull()
        .defaultTo('e164')
        .check(sql`inbound_number_format in ('e164','national')`)
    )
    .addColumn('callerid_format', 'text', col =>
      col
        .notNull()
        .defaultTo('e164')
        .check(sql`callerid_format in ('e164','national')`)
    )
    .addColumn('callerid_header', 'text', col =>
      col
        .notNull()
        .defaultTo('from')
        .check(sql`callerid_header in ('from','pai','both')`)
    )
    .addColumn('clir', 'integer', col => col.check(sql`clir in (0,1)`))
    .addColumn('codecs_json', 'text')
    .addColumn('max_channels', 'integer', col =>
      col.check(sql`max_channels > 0`)
    )
    .addColumn('log_level', 'text', col =>
      col.check(sql`log_level in ('events','qos','sip')`)
    )
    .addColumn('log_level_expires_at', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addCheckConstraint(
      'trunks_auth_credentials',
      sql`(auth_mode = 'registration' or inbound_auth = 1) = (username is not null and password_enc is not null)`
    )
    .addCheckConstraint(
      'trunks_register_fields_need_registration',
      sql`auth_mode = 'registration' or (register_expiry_s is null and register_retry_s is null)`
    )
    .addCheckConstraint(
      'trunks_clir_needs_callerid_header',
      sql`clir is not 1 or callerid_header in ('pai','both')`
    )
    .execute();
}

/** The two partial unique indexes the initial migration put on `trunks`, dropped with it. */
async function createTrunksIndexes(db: Db): Promise<void> {
  await db.schema
    .createIndex('trunks_name')
    .on('trunks')
    .unique()
    .column('name')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
  await db.schema
    .createIndex('trunks_priority')
    .on('trunks')
    .unique()
    .column('priority')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

/** The columns both tables share, copied as they are. */
const COPIED_COLUMNS = [
  'id',
  'name',
  'priority',
  'auth_mode',
  'username',
  'password_enc',
  'inbound_auth',
  'transport',
  'outbound_proxy',
  'register_expiry_s',
  'register_retry_s',
  'inbound_number_format',
  'callerid_format',
  'callerid_header',
  'clir',
  'codecs_json',
  'max_channels',
  'log_level',
  'log_level_expires_at',
  'created_at',
  'deleted_at'
] as const;

async function rebuildTrunks(trx: Db): Promise<void> {
  await createTrunksNew(trx);
  const columns = sql.join(COPIED_COLUMNS.map(column => sql.ref(column)));
  await sql`INSERT INTO trunks_new (${columns}, emergency) SELECT ${columns}, 1 FROM trunks`.execute(
    trx
  );
  await trx.schema.dropTable('trunks').execute();
  await trx.schema.alterTable('trunks_new').renameTo('trunks').execute();
  await createTrunksIndexes(trx);
  // `trunk_hosts` and `outbound_routes` reference `trunks` by name, so they point at the new
  // table once it is renamed; this confirms no row lost its parent on the way.
  const { rows } = await sql`PRAGMA foreign_key_check`.execute(trx);
  if (rows.length > 0) {
    throw new Error('trunks rebuild left dangling foreign keys');
  }
}

export async function up(db: Db): Promise<void> {
  // Dropping `trunks` with foreign keys enforced would cascade into `trunk_hosts` and be refused
  // by `outbound_routes`; the pragma is a no-op inside a transaction, so it is switched here, on
  // the migrator's connection, which Kysely does not wrap in one for SQLite.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(rebuildTrunks);
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function down(db: Db): Promise<void> {
  await db.schema.alterTable('trunks').dropColumn('emergency').execute();
}
