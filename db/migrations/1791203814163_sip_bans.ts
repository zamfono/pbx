import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// Named §11.4 defaults: `no-magic-numbers` requires every meaningful literal to carry a name.
const DEFAULT_SIP_BAN_FAILURES = 10;
const DEFAULT_SIP_BAN_WINDOW_S = 3600;
const DEFAULT_SIP_BAN_SUCCESS_EXEMPT_S = 86400;
const DEFAULT_SIP_BAN_STEPS_JSON = '[86400,31536000,null]';
const DEFAULT_SIP_BAN_LOOKBACK_S = 2592000;

// settings — the SIP ban thresholds and escalation steps (§5.6, §11.4).
async function addSettingsSipBanColumns(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('sip_ban_failures', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SIP_BAN_FAILURES)
        .check(sql`sip_ban_failures >= 1`)
    )
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('sip_ban_window_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SIP_BAN_WINDOW_S)
        .check(sql`sip_ban_window_s BETWEEN 1 AND 3153600000`)
    )
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('sip_ban_success_exempt_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SIP_BAN_SUCCESS_EXEMPT_S)
        .check(sql`sip_ban_success_exempt_s BETWEEN 0 AND 3153600000`)
    )
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('sip_ban_steps_json', 'text', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SIP_BAN_STEPS_JSON)
        .check(sql`json_type(sip_ban_steps_json) = 'array'`)
    )
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('sip_ban_lookback_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SIP_BAN_LOOKBACK_S)
        .check(sql`sip_ban_lookback_s BETWEEN 1 AND 3153600000`)
    )
    .execute();
}

// sip_allowlist — source addresses never banned for failed SIP attempts (§5.6).
async function createSipAllowlistTable(db: Db): Promise<void> {
  await db.schema
    .createTable('sip_allowlist')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('address', 'text', col =>
      col
        .notNull()
        .check(sql`address <> '' and address not glob '*[^0-9A-Fa-f.:/]*'`)
    )
    .addColumn('label', 'text')
    .addColumn('created_by', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('sip_allowlist_address')
    .on('sip_allowlist')
    .unique()
    .column('address')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// sip_bans — a row per ban of a source address, kept after it ended as the address's history (§5.6).
async function createSipBansTable(db: Db): Promise<void> {
  await db.schema
    .createTable('sip_bans')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('address', 'text', col =>
      col
        .notNull()
        .check(sql`address <> '' and address not glob '*[^0-9a-f.:/]*'`)
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
}

export async function up(db: Db): Promise<void> {
  await addSettingsSipBanColumns(db);
  await createSipAllowlistTable(db);
  await createSipBansTable(db);
}
