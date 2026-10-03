/* eslint-disable max-lines -- the DDL mirrors the spec's full schema (§11.2), one table per statement */
import { sql, type CreateTableBuilder, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

const TABLE_NAMES = [
  'users',
  'devices',
  'device_blf_keys',
  'trunks',
  'trunk_hosts',
  'outbound_routes',
  'outbound_route_users',
  'outbound_route_user_groups',
  'outbound_route_numbers',
  'did_blocks',
  'dids',
  'ring_groups',
  'ring_group_members',
  'user_groups',
  'user_group_users',
  'user_group_groups',
  'extensions',
  'forward_targets',
  'menus',
  'menu_targets',
  'user_forward_rules',
  'ring_group_forward_rules',
  'settings',
  'ooo_rules',
  'opening_hours',
  'opening_hours_intervals',
  'audio_assets',
  'blocked_numbers',
  'mail_templates',
  'contacts',
  'contact_phones',
  'oauth_clients',
  'tokens',
  'webhooks',
  'webhook_deliveries',
  'backup_targets',
  'backup_runs',
  'audit_log',
  'calls',
  'call_qos',
  'voicemails',
  'recordings',
  'presence_log',
  'update_state',
  'maintenance_gate'
] as const;

// Named §11.4 defaults: `no-magic-numbers` requires every meaningful literal to carry a name.
const DEFAULT_USER_RING_TIMEOUT_S = 25;
const DEFAULT_RING_GROUP_RING_TIMEOUT_S = 20;
const DEFAULT_MENU_TIMEOUT_S = 5;
const DEFAULT_MENU_MAX_ATTEMPTS = 3;
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_EXT_LENGTH = 3;
const DEFAULT_VOICEMAIL_MAX_S = 180;
const DEFAULT_PARKING_TIMEOUT_S = 300;
const DEFAULT_RECORDING_RETENTION_DAYS = 90;
const DEFAULT_SOFT_DELETE_RETENTION_DAYS = 30;
const DEFAULT_RINGOTEL_MAX_REGS = 3;
const DEFAULT_FEATURE_CODES_JSON =
  '{"pickup":"*8","dndOn":"*90","dndOff":"*91","mailbox":"*95","ownVoicemail":"*96","deposit":"*97","addParty":"*5","clirOn":"#31#","clirOff":"*31#","park":"*70"}';
const DEFAULT_CODECS_JSON = '["opus","g722","alaw"]';
const DEFAULT_BACKUP_CRON = '0 3 * * *';

// users — one row per person (§11.2).
async function createUsersTable(db: Db): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('email', 'text', col =>
      col.notNull().modifyFront(sql`collate nocase`)
    )
    .addColumn('role', 'text', col =>
      col
        .notNull()
        .defaultTo('user')
        .check(sql`role in ('owner','admin','user')`)
    )
    .addColumn('password_hash', 'text')
    .addColumn('sso_subject', 'text')
    .addColumn('ring_timeout_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_USER_RING_TIMEOUT_S)
        .check(sql`ring_timeout_s > 0`)
    )
    .addColumn('dnd', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`dnd in (0,1)`)
    )
    .addColumn('find_me_json', 'text')
    .addColumn('callerid_did_id', 'text', col =>
      col.references('dids.id').onDelete('set null')
    )
    .addColumn('clir', 'integer', col => col.check(sql`clir in (0,1)`))
    .addColumn('reject_anonymous', 'integer', col =>
      col.check(sql`reject_anonymous in (0,1)`)
    )
    .addColumn('record_calls', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`record_calls in (0,1)`)
    )
    .addColumn('notify_missed_calls', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`notify_missed_calls in (0,1)`)
    )
    .addColumn('mailbox_enabled', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`mailbox_enabled in (0,1)`)
    )
    .addColumn('mailbox_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('set null')
    )
    .addColumn('log_level', 'text', col =>
      col.check(sql`log_level in ('events','qos','sip')`)
    )
    .addColumn('log_level_expires_at', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addCheckConstraint(
      'users_owner_password_hash',
      sql`role <> 'owner' or password_hash is not null`
    )
    .execute();
}

async function createUsersIndexes(db: Db): Promise<void> {
  await db.schema
    .createIndex('users_email')
    .on('users')
    .unique()
    .column('email')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
  await db.schema
    .createIndex('users_sso_subject')
    .on('users')
    .unique()
    .column('sso_subject')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// devices — SIP endpoints; device_blf_keys — a Ringotel device's BLF panel.
async function createDevicesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('devices')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('label', 'text', col => col.notNull())
    .addColumn('kind', 'text', col =>
      col.notNull().check(sql`kind in ('manual','ringotel')`)
    )
    .addColumn('transport', 'text', col =>
      col
        .notNull()
        .defaultTo('tls')
        .check(sql`transport in ('tls','plain')`)
    )
    .addColumn('allowed_ips_json', 'text')
    .addColumn('sip_username', 'text', col => col.notNull())
    .addColumn('sip_password_enc', 'blob', col => col.notNull())
    .addColumn('last_registered_at', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addCheckConstraint(
      'devices_plain_needs_allowed_ips',
      sql`(transport = 'plain') = (allowed_ips_json is not null)`
    )
    .addCheckConstraint(
      'devices_manual_or_tls',
      sql`kind = 'manual' or transport = 'tls'`
    )
    .execute();
  await db.schema
    .createIndex('devices_sip_username')
    .on('devices')
    .unique()
    .column('sip_username')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createDeviceBlfKeysTable(db: Db): Promise<void> {
  await db.schema
    .createTable('device_blf_keys')
    .addColumn('device_id', 'text', col =>
      col.notNull().references('devices.id').onDelete('cascade')
    )
    .addColumn('ext', 'text', col =>
      col.notNull().references('extensions.ext').onDelete('cascade')
    )
    .addColumn('position', 'integer', col => col.notNull())
    .addPrimaryKeyConstraint('device_blf_keys_pk', ['device_id', 'ext'])
    .addUniqueConstraint('device_blf_keys_position_unique', [
      'device_id',
      'position'
    ])
    .execute();
}

// trunks — PSTN connectivity.
// The trunk's media encryption, certificate check, OPTIONS probe and `Diversion` header (§9.4).
function addTrunksSignalingColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('srtp', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`srtp in (0,1) and (srtp = 0 or transport = 'tls')`)
    )
    .addColumn('tls_verify', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`tls_verify in (0,1)`)
    )
    .addColumn('qualify', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`qualify in (0,1)`)
    )
    .addColumn('diversion', 'text', col =>
      col
        .notNull()
        .defaultTo('off')
        .check(sql`diversion in ('off','last','all')`)
    );
}

async function createTrunksTable(db: Db): Promise<void> {
  await db.schema
    .createTable('trunks')
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
    .$call(addTrunksSignalingColumns)
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

// trunk_hosts — a trunk's ordered host list.
async function createTrunkHostsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('trunk_hosts')
    .addColumn('trunk_id', 'text', col =>
      col.notNull().references('trunks.id').onDelete('cascade')
    )
    .addColumn('priority', 'integer', col => col.notNull())
    .addColumn('host', 'text', col => col.notNull())
    .addColumn('port', 'integer')
    .addColumn('direction', 'text', col =>
      col
        .notNull()
        .defaultTo('both')
        .check(sql`direction in ('both','outbound','inbound')`)
    )
    .addPrimaryKeyConstraint('trunk_hosts_pk', ['trunk_id', 'priority'])
    .execute();
}

// outbound_routes — trunk selection and its caller/number lists.
async function createOutboundRoutesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('outbound_routes')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('priority', 'integer', col => col.notNull())
    .addColumn('trunk_id', 'text', col =>
      col.notNull().references('trunks.id').onDelete('restrict')
    )
    .addColumn('callerid_did_id', 'text', col =>
      col.references('dids.id').onDelete('set null')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('outbound_routes_priority')
    .on('outbound_routes')
    .unique()
    .column('priority')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createOutboundRouteUsersTable(db: Db): Promise<void> {
  await db.schema
    .createTable('outbound_route_users')
    .addColumn('route_id', 'text', col =>
      col.notNull().references('outbound_routes.id').onDelete('cascade')
    )
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addPrimaryKeyConstraint('outbound_route_users_pk', ['route_id', 'user_id'])
    .execute();
}

async function createOutboundRouteUserGroupsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('outbound_route_user_groups')
    .addColumn('route_id', 'text', col =>
      col.notNull().references('outbound_routes.id').onDelete('cascade')
    )
    .addColumn('user_group_id', 'text', col =>
      col.notNull().references('user_groups.id').onDelete('cascade')
    )
    .addPrimaryKeyConstraint('outbound_route_user_groups_pk', [
      'route_id',
      'user_group_id'
    ])
    .execute();
}

async function createOutboundRouteNumbersTable(db: Db): Promise<void> {
  await db.schema
    .createTable('outbound_route_numbers')
    .addColumn('route_id', 'text', col =>
      col.notNull().references('outbound_routes.id').onDelete('cascade')
    )
    .addColumn('number', 'text', col =>
      col
        .notNull()
        .check(
          sql`number glob '+[0-9]*' and substr(number, 2) not glob '*[^0-9]*'`
        )
    )
    .addColumn('is_prefix', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`is_prefix in (0,1)`)
    )
    .addPrimaryKeyConstraint('outbound_route_numbers_pk', [
      'route_id',
      'number'
    ])
    .execute();
}

// did_blocks / dids — number blocks and inbound numbers (§11.3).
async function createDidBlocksTable(db: Db): Promise<void> {
  await db.schema
    .createTable('did_blocks')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('base', 'text', col => col.notNull())
    .addColumn('label', 'text')
    .addColumn('digits', 'integer', col => col.check(sql`digits > 0`))
    .addColumn('fallback_target_id', 'text', col =>
      col.references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('did_blocks_base')
    .on('did_blocks')
    .unique()
    .column('base')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createDidsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('dids')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('number', 'text', col => col.notNull())
    .addColumn('label', 'text')
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('dids_number')
    .on('dids')
    .unique()
    .column('number')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// ring_groups — call distribution.
async function createRingGroupsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('ring_groups')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('strategy', 'text', col =>
      col
        .notNull()
        .check(sql`strategy in ('simultaneous','sequential','random')`)
    )
    .addColumn('ring_timeout_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_RING_GROUP_RING_TIMEOUT_S)
        .check(sql`ring_timeout_s > 0`)
    )
    .addColumn('ring_total_s', 'integer', col =>
      col.check(sql`ring_total_s > 0`)
    )
    .addColumn('skip_busy', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`skip_busy in (0,1)`)
    )
    .addColumn('allow_reject', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`allow_reject in (0,1)`)
    )
    .addColumn('greeting_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('set null')
    )
    .addColumn('moh_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('set null')
    )
    .addColumn('record_calls', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`record_calls in (0,1)`)
    )
    .addColumn('mailbox_enabled', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`mailbox_enabled in (0,1)`)
    )
    .addColumn('mailbox_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('set null')
    )
    .addColumn('log_level', 'text', col =>
      col.check(sql`log_level in ('events','qos','sip')`)
    )
    .addColumn('log_level_expires_at', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('ring_groups_name')
    .on('ring_groups')
    .unique()
    .column('name')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createRingGroupMembersTable(db: Db): Promise<void> {
  await db.schema
    .createTable('ring_group_members')
    .addColumn('group_id', 'text', col =>
      col.notNull().references('ring_groups.id').onDelete('cascade')
    )
    .addColumn('position', 'integer', col => col.notNull())
    .addColumn('user_id', 'text', col =>
      col.references('users.id').onDelete('cascade')
    )
    .addColumn('user_group_id', 'text', col =>
      col.references('user_groups.id').onDelete('cascade')
    )
    .addPrimaryKeyConstraint('ring_group_members_pk', ['group_id', 'position'])
    .addUniqueConstraint('ring_group_members_user_unique', [
      'group_id',
      'user_id'
    ])
    .addUniqueConstraint('ring_group_members_user_group_unique', [
      'group_id',
      'user_group_id'
    ])
    .addCheckConstraint(
      'ring_group_members_one_target',
      sql`(user_id is not null) + (user_group_id is not null) = 1`
    )
    .execute();
}

// user_groups — organizational grouping.
async function createUserGroupsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('user_groups')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('user_groups_name')
    .on('user_groups')
    .unique()
    .column('name')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createUserGroupUsersTable(db: Db): Promise<void> {
  await db.schema
    .createTable('user_group_users')
    .addColumn('group_id', 'text', col =>
      col.notNull().references('user_groups.id').onDelete('cascade')
    )
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addPrimaryKeyConstraint('user_group_users_pk', ['group_id', 'user_id'])
    .execute();
}

async function createUserGroupGroupsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('user_group_groups')
    .addColumn('parent_group_id', 'text', col =>
      col.notNull().references('user_groups.id').onDelete('cascade')
    )
    .addColumn('child_group_id', 'text', col =>
      col.notNull().references('user_groups.id').onDelete('cascade')
    )
    .addPrimaryKeyConstraint('user_group_groups_pk', [
      'parent_group_id',
      'child_group_id'
    ])
    .execute();
}

// extensions — the tenant's numbering space.
async function createExtensionsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('extensions')
    .addColumn('ext', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.unique().references('users.id').onDelete('cascade')
    )
    .addColumn('ring_group_id', 'text', col =>
      col.unique().references('ring_groups.id').onDelete('cascade')
    )
    .addColumn('is_parking_slot', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`is_parking_slot in (0,1)`)
    )
    .addCheckConstraint(
      'extensions_one_owner',
      sql`(user_id is not null) + (ring_group_id is not null) + is_parking_slot = 1`
    )
    .addCheckConstraint(
      'extensions_ext_digits',
      sql`ext not glob '*[^0-9]*' and length(ext) >= 1`
    )
    .execute();
}

// forward_targets — the shared target vocabulary.
async function createForwardTargetsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('forward_targets')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.references('users.id').onDelete('restrict')
    )
    .addColumn('ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('restrict')
    )
    .addColumn('external', 'text', col =>
      col.check(
        sql`external is null or (external glob '+[0-9]*' and substr(external, 2) not glob '*[^0-9]*')`
      )
    )
    .addColumn('sip_trunk_id', 'text', col =>
      col.references('trunks.id').onDelete('restrict')
    )
    .addColumn('sip_user', 'text', col =>
      col.check(
        sql`sip_user is null or (length(sip_user) between 1 and 64 and sip_user not glob '*[^A-Za-z0-9._~+-]*')`
      )
    )
    .addColumn('mailbox_user_id', 'text', col =>
      col.references('users.id').onDelete('restrict')
    )
    .addColumn('mailbox_ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('restrict')
    )
    .addColumn('announcement_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('restrict')
    )
    .addColumn('menu_id', 'text', col =>
      col.references('menus.id').onDelete('restrict')
    )
    .addColumn('sip_headers_json', 'text', col =>
      col.check(
        sql`sip_headers_json is null or (sip_trunk_id is not null and json_valid(sip_headers_json) and json_type(sip_headers_json) = 'array')`
      )
    )
    .addCheckConstraint(
      'forward_targets_sip_pair',
      sql`(sip_trunk_id is null) = (sip_user is null)`
    )
    .addCheckConstraint(
      'forward_targets_one_kind',
      sql`(user_id is not null) + (ring_group_id is not null) + (external is not null) +
             (sip_trunk_id is not null) + (mailbox_user_id is not null) +
             (mailbox_ring_group_id is not null) + (announcement_audio_id is not null) +
             (menu_id is not null) = 1`
    )
    .execute();
}

// menus — auto-attendant menus and their rules.
async function createMenusTable(db: Db): Promise<void> {
  await db.schema
    .createTable('menus')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('audio_id', 'text', col =>
      col.notNull().references('audio_assets.id').onDelete('restrict')
    )
    .addColumn('timeout_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_MENU_TIMEOUT_S)
        .check(sql`timeout_s > 0`)
    )
    .addColumn('max_attempts', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_MENU_MAX_ATTEMPTS)
        .check(sql`max_attempts > 0`)
    )
    .addColumn('allow_extension_dialing', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`allow_extension_dialing in (0,1)`)
    )
    .addColumn('fallback_target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('menus_name')
    .on('menus')
    .unique()
    .column('name')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createMenuTargetsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('menu_targets')
    .addColumn('menu_id', 'text', col =>
      col.notNull().references('menus.id').onDelete('cascade')
    )
    .addColumn('digits', 'text', col =>
      col
        .notNull()
        .check(sql`digits not glob '*[^0-9*#]*' and length(digits) >= 1`)
    )
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addPrimaryKeyConstraint('menu_targets_pk', ['menu_id', 'digits'])
    .execute();
}

async function createUserForwardRulesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('user_forward_rules')
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('condition', 'text', col =>
      col
        .notNull()
        .check(
          sql`condition in ('unconditional','busy','noAnswer','dnd','offline')`
        )
    )
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addPrimaryKeyConstraint('user_forward_rules_pk', ['user_id', 'condition'])
    .execute();
}

async function createRingGroupForwardRulesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('ring_group_forward_rules')
    .addColumn('group_id', 'text', col =>
      col.notNull().references('ring_groups.id').onDelete('cascade')
    )
    .addColumn('condition', 'text', col =>
      col.notNull().check(sql`condition in ('unanswered','unavailable')`)
    )
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addPrimaryKeyConstraint('ring_group_forward_rules_pk', [
      'group_id',
      'condition'
    ])
    .execute();
}

// settings — tenant configuration as one typed row (§11.4). Split across several `$call` helpers
// so no single function holds all ~40 columns.
function addSettingsIdentityColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('id', 'integer', col => col.primaryKey().check(sql`id = 1`))
    .addColumn('company_name', 'text', col => col.notNull())
    .addColumn('main_did_id', 'text', col =>
      col.notNull().references('dids.id').onDelete('restrict')
    )
    .addColumn('country', 'text', col => col.notNull())
    .addColumn('timezone', 'text')
    .addColumn('language', 'text', col =>
      col
        .notNull()
        .defaultTo('en')
        .check(sql`language in ('de','en','es','fr','it','ru')`)
    );
}

function addSettingsMailColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('smtp_host', 'text')
    .addColumn('smtp_port', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SMTP_PORT)
        .check(sql`smtp_port between 1 and 65535`)
    )
    .addColumn('smtp_security', 'text', col =>
      col
        .notNull()
        .defaultTo('tls')
        .check(sql`smtp_security in ('tls','starttls')`)
    )
    .addColumn('smtp_user', 'text')
    .addColumn('smtp_password_enc', 'blob')
    .addColumn('mail_from', 'text');
}

function addSettingsDialplanColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('ext_length', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_EXT_LENGTH)
        .check(sql`ext_length >= 2`)
    )
    .addColumn('emergency_numbers_json', 'text', col => col.notNull())
    .addColumn('feature_codes_json', 'text', col =>
      col.notNull().defaultTo(DEFAULT_FEATURE_CODES_JSON)
    )
    .addColumn('fallback_target_id', 'text', col =>
      col.references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('codecs_json', 'text', col =>
      col.notNull().defaultTo(DEFAULT_CODECS_JSON)
    )
    .addColumn('clir', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`clir in (0,1)`)
    )
    .addColumn('reject_anonymous', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`reject_anonymous in (0,1)`)
    );
}

function addSettingsCallColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('hold_moh_audio_id', 'text', col =>
      col.references('audio_assets.id').onDelete('set null')
    )
    .addColumn('voicemail_max_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_VOICEMAIL_MAX_S)
        .check(sql`voicemail_max_s > 0`)
    )
    .addColumn('parking_timeout_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_PARKING_TIMEOUT_S)
        .check(sql`parking_timeout_s > 0`)
    )
    .addColumn('call_log_level', 'text', col =>
      col
        .notNull()
        .defaultTo('events')
        .check(sql`call_log_level in ('none','events','qos','sip')`)
    );
}

function addSettingsRetentionColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('recording_retention_days', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_RECORDING_RETENTION_DAYS)
        .check(sql`recording_retention_days > 0`)
    )
    .addColumn('soft_delete_retention_days', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_SOFT_DELETE_RETENTION_DAYS)
        .check(sql`soft_delete_retention_days >= 1`)
    )
    .addColumn('audit_retention_days', 'integer', col =>
      col.check(sql`audit_retention_days >= 30`)
    )
    .addColumn('backup_cron', 'text', col =>
      col.notNull().defaultTo(DEFAULT_BACKUP_CRON)
    )
    .addColumn('tls_reload_hour', 'integer', col =>
      col.check(sql`tls_reload_hour between 0 and 23`)
    );
}

function addSettingsSsoColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('sso_provider', 'text', col =>
      col.check(sql`sso_provider in ('microsoft','google','oidc')`)
    )
    .addColumn('sso_label', 'text')
    .addColumn('sso_issuer', 'text')
    .addColumn('sso_client_id', 'text')
    .addColumn('sso_tenant_id', 'text')
    .addColumn('sso_allowed_domain', 'text')
    .addColumn('sso_client_secret_enc', 'blob');
}

function addSettingsRingotelColumns<TB extends string, C extends string>(
  builder: CreateTableBuilder<TB, C>
) {
  return builder
    .addColumn('ringotel_org_id', 'text')
    .addColumn('ringotel_branch_id', 'text')
    .addColumn('ringotel_max_regs', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_RINGOTEL_MAX_REGS)
        .check(sql`ringotel_max_regs > 0`)
    )
    .addColumn('ringotel_api_token_enc', 'blob')
    .addColumn('ringotel_profile_pending', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`ringotel_profile_pending in (0,1)`)
    );
}

async function createSettingsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('settings')
    .$call(addSettingsIdentityColumns)
    .$call(addSettingsMailColumns)
    .$call(addSettingsDialplanColumns)
    .$call(addSettingsCallColumns)
    .$call(addSettingsRetentionColumns)
    .$call(addSettingsSsoColumns)
    .$call(addSettingsRingotelColumns)
    .addColumn('auto_update', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`auto_update in (0,1)`)
    )
    .addColumn('config_propagation_pending', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`config_propagation_pending in (0,1)`)
    )
    .addCheckConstraint(
      'settings_sso_provider_needs_client_id',
      sql`sso_provider is null or sso_client_id is not null`
    )
    .addCheckConstraint(
      'settings_sso_microsoft_needs_tenant',
      sql`sso_provider is not 'microsoft' or sso_tenant_id is not null`
    )
    .addCheckConstraint(
      'settings_sso_oidc_needs_issuer_and_label',
      sql`sso_provider is not 'oidc' or (sso_issuer is not null and sso_label is not null)`
    )
    .execute();
}

// ooo_rules / opening_hours — schedules that route calls while a scope is away or closed.
async function createOooRulesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('ooo_rules')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('scope_user_id', 'text', col =>
      col.references('users.id').onDelete('cascade')
    )
    .addColumn('scope_ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('cascade')
    )
    .addColumn('scope_menu_id', 'text', col =>
      col.references('menus.id').onDelete('cascade')
    )
    .addColumn('active', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`active in (0,1)`)
    )
    .addColumn('starts_at', 'text')
    .addColumn('expires_at', 'text')
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addCheckConstraint(
      'ooo_rules_at_most_one_scope',
      sql`(scope_user_id is not null) + (scope_ring_group_id is not null) + (scope_menu_id is not null) <= 1`
    )
    .addCheckConstraint(
      'ooo_rules_starts_before_expires',
      sql`starts_at is null or expires_at is null or starts_at < expires_at`
    )
    .execute();
}

async function createOpeningHoursTable(db: Db): Promise<void> {
  await db.schema
    .createTable('opening_hours')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('scope_user_id', 'text', col =>
      col.references('users.id').onDelete('cascade')
    )
    .addColumn('scope_ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('cascade')
    )
    .addColumn('scope_menu_id', 'text', col =>
      col.references('menus.id').onDelete('cascade')
    )
    .addColumn('active', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`active in (0,1)`)
    )
    .addColumn('closed_target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addCheckConstraint(
      'opening_hours_at_most_one_scope',
      sql`(scope_user_id is not null) + (scope_ring_group_id is not null) + (scope_menu_id is not null) <= 1`
    )
    .execute();
}

async function createOpeningHoursIndexes(db: Db): Promise<void> {
  await db.schema
    .createIndex('opening_hours_scope_user')
    .on('opening_hours')
    .unique()
    .column('scope_user_id')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
  await db.schema
    .createIndex('opening_hours_scope_ring_group')
    .on('opening_hours')
    .unique()
    .column('scope_ring_group_id')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
  await db.schema
    .createIndex('opening_hours_scope_menu')
    .on('opening_hours')
    .unique()
    .column('scope_menu_id')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createOpeningHoursIntervalsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('opening_hours_intervals')
    .addColumn('opening_hours_id', 'text', col =>
      col.notNull().references('opening_hours.id').onDelete('cascade')
    )
    .addColumn('weekday', 'integer', col =>
      col.notNull().check(sql`weekday between 1 and 7`)
    )
    .addColumn('opens', 'text', col => col.notNull())
    .addColumn('closes', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('opening_hours_intervals_pk', [
      'opening_hours_id',
      'weekday',
      'opens'
    ])
    .addCheckConstraint(
      'opening_hours_intervals_opens_before_closes',
      sql`opens < closes`
    )
    .execute();
}

// audio_assets — uploaded audio; blocked_numbers — the inbound blocklist.
async function createAudioAssetsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('audio_assets')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('label', 'text', col => col.notNull())
    .addColumn('kind', 'text', col =>
      col
        .notNull()
        .check(sql`kind in ('greeting','moh','vmGreeting','announcement')`)
    )
    .addColumn('filename', 'text', col => col.notNull())
    .addColumn('uploaded_by', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('audio_assets_filename')
    .on('audio_assets')
    .unique()
    .column('filename')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

async function createBlockedNumbersTable(db: Db): Promise<void> {
  await db.schema
    .createTable('blocked_numbers')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('number', 'text', col =>
      col
        .notNull()
        .check(
          sql`number glob '+[0-9]*' and substr(number, 2) not glob '*[^0-9]*'`
        )
    )
    .addColumn('is_prefix', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`is_prefix in (0,1)`)
    )
    .addColumn('label', 'text')
    .addColumn('created_by', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('blocked_numbers_number')
    .on('blocked_numbers')
    .unique()
    .columns(['number', 'is_prefix'])
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// mail_templates, contacts and contact_phones.
async function createMailTemplatesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('mail_templates')
    .addColumn('kind', 'text', col =>
      col
        .notNull()
        .check(
          sql`kind in ('voicemail','missedCall','setup','reset','updateFailed','breakingUpdate')`
        )
    )
    .addColumn('language', 'text', col =>
      col.notNull().check(sql`language in ('de','en','es','fr','it','ru')`)
    )
    .addColumn('subject', 'text', col => col.notNull())
    .addColumn('body_text', 'text', col => col.notNull())
    .addColumn('body_html', 'text')
    .addColumn('updated_at', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('mail_templates_pk', ['kind', 'language'])
    .execute();
}

async function createContactsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('contacts')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('display_name', 'text', col => col.notNull())
    .addColumn('company', 'text')
    .addColumn('email', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('updated_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
}

async function createContactPhonesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('contact_phones')
    .addColumn('contact_id', 'text', col =>
      col.notNull().references('contacts.id').onDelete('cascade')
    )
    .addColumn('number', 'text', col => col.notNull())
    .addColumn('label', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('contact_phones_pk', ['contact_id', 'number'])
    .addUniqueConstraint('contact_phones_label_unique', ['contact_id', 'label'])
    .execute();
}

// oauth_clients, tokens, webhooks — auth and event-delivery security tables.
async function createOauthClientsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('oauth_clients')
    .addColumn('client_id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('kind', 'text', col =>
      col.notNull().check(sql`kind in ('metadata','cimd')`)
    )
    .addColumn('redirect_uris_json', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('last_login_at', 'text', col => col.notNull())
    .execute();
}

async function createTokensTable(db: Db): Promise<void> {
  await db.schema
    .createTable('tokens')
    .addColumn('token_hash', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('kind', 'text', col =>
      col.notNull().check(sql`kind in ('refresh','reset')`)
    )
    .addColumn('client_id', 'text', col =>
      col.references('oauth_clients.client_id').onDelete('cascade')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('expires_at', 'text', col => col.notNull())
    .addColumn('revoked_at', 'text')
    .addCheckConstraint(
      'tokens_refresh_needs_client',
      sql`(kind = 'refresh') = (client_id is not null)`
    )
    .execute();
}

async function createWebhooksTable(db: Db): Promise<void> {
  await db.schema
    .createTable('webhooks')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('url', 'text', col => col.notNull())
    .addColumn('event_types_json', 'text')
    .addColumn('active', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`active in (0,1)`)
    )
    .addColumn('secret_enc', 'blob', col => col.notNull())
    .addColumn('last_status', 'text', col =>
      col.check(sql`last_status in ('ok','failing')`)
    )
    .addColumn('last_delivery_at', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addColumn('last_error', 'text')
    .addColumn('last_error_at', 'text')
    .addColumn('failing_since', 'text')
    .addColumn('last_logged_at', 'text')
    .addColumn('failed_deliveries', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`failed_deliveries >= 0`)
    )
    .execute();
}

// webhook_deliveries — the webhook outbox (§10.6), one row per hook and event until delivered or
// given up, so a queued or retrying delivery survives an `api` restart.
async function createWebhookDeliveriesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('webhook_id', 'text', col =>
      col.notNull().references('webhooks.id').onDelete('cascade')
    )
    .addColumn('body_json', 'text', col => col.notNull())
    .addColumn('attempts', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`attempts >= 0`)
    )
    .addColumn('next_attempt_at', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .execute();
  await db.schema
    .createIndex('webhook_deliveries_webhook')
    .on('webhook_deliveries')
    .column('webhook_id')
    .execute();
}

// backup_targets / backup_runs — restic backups (§6.5); audit_log — the append-only audit trail.
async function createBackupTargetsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('backup_targets')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('kind', 'text', col =>
      col
        .notNull()
        .check(sql`kind in ('local','ftp','ftps','sftp','s3','webdav')`)
    )
    .addColumn('params_json', 'text', col => col.notNull())
    .addColumn('enabled', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`enabled in (0,1)`)
    )
    .addColumn('secret_enc', 'blob', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
}

async function createBackupRunsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('backup_runs')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('target_id', 'text', col =>
      col.notNull().references('backup_targets.id').onDelete('cascade')
    )
    .addColumn('status', 'text', col =>
      col.notNull().check(sql`status in ('running','ok','failed')`)
    )
    .addColumn('snapshot_id', 'text')
    .addColumn('bytes_added', 'integer')
    .addColumn('error', 'text')
    .addColumn('started_at', 'text', col => col.notNull())
    .addColumn('finished_at', 'text')
    .addColumn('bytes_total', 'integer')
    .execute();
}

async function createAuditLogTable(db: Db): Promise<void> {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('actor_user_id', 'text', col => col.notNull())
    .addColumn('actor_user_name', 'text', col => col.notNull())
    .addColumn('channel', 'text', col =>
      col.notNull().check(sql`channel in ('rest','mcp','ui','undo','job')`)
    )
    .addColumn('client_id', 'text')
    .addColumn('client_name', 'text')
    .addColumn('operation', 'text', col => col.notNull())
    .addColumn('entity_kind', 'text', col => col.notNull())
    .addColumn('entity_id', 'text')
    .addColumn('changes_json', 'text', col => col.notNull())
    .addColumn('undoable', 'integer', col =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`undoable in (0,1)`)
    )
    .addColumn('reverts_id', 'text')
    .addColumn('undone_at', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .execute();
}

// calls, call_qos, voicemails, recordings, presence_log — the runtime history core writes.
async function createCallsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('calls')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('parent_call_id', 'text', col =>
      col.references('calls.id').onDelete('set null')
    )
    .addColumn('direction', 'text', col =>
      col.notNull().check(sql`direction in ('inbound','outbound','internal')`)
    )
    .addColumn('from_uri', 'text', col => col.notNull())
    .addColumn('to_uri', 'text', col => col.notNull())
    .addColumn('did_id', 'text', col =>
      col.references('dids.id').onDelete('set null')
    )
    .addColumn('caller_user_id', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('callee_user_id', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('set null')
    )
    .addColumn('answered_by_user_id', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('status', 'text', col =>
      col
        .notNull()
        .check(
          sql`status in ('answered','missed','busy','failed','voicemail','blocked','interrupted')`
        )
    )
    .addColumn('started_at', 'text', col => col.notNull())
    .addColumn('answered_at', 'text')
    .addColumn('ended_at', 'text')
    .addColumn('log', 'text')
    .execute();
}

async function createCallQosTable(db: Db): Promise<void> {
  await db.schema
    .createTable('call_qos')
    .addColumn('call_id', 'text', col =>
      col.notNull().references('calls.id').onDelete('cascade')
    )
    .addColumn('channel_id', 'text', col => col.notNull())
    .addColumn('role', 'text', col =>
      col.notNull().check(sql`role in ('caller','callee')`)
    )
    .addColumn('jitter_ms', 'real')
    .addColumn('loss_pct', 'real')
    .addColumn('rtt_ms', 'real')
    .addColumn('rx_packets', 'integer', col => col.check(sql`rx_packets >= 0`))
    .addColumn('tx_packets', 'integer', col => col.check(sql`tx_packets >= 0`))
    .addPrimaryKeyConstraint('call_qos_pk', ['call_id', 'channel_id'])
    .execute();
}

async function createVoicemailsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('voicemails')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('mailbox_user_id', 'text', col =>
      col.references('users.id').onDelete('cascade')
    )
    .addColumn('mailbox_ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('cascade')
    )
    .addColumn('caller', 'text', col => col.notNull())
    .addColumn('filename', 'text', col => col.notNull().unique())
    .addColumn('duration_s', 'integer', col => col.notNull())
    .addColumn('read', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`read in (0,1)`)
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addCheckConstraint(
      'voicemails_one_mailbox',
      sql`(mailbox_user_id is not null) + (mailbox_ring_group_id is not null) = 1`
    )
    .execute();
}

async function createRecordingsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('recordings')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('call_id', 'text', col =>
      col.notNull().references('calls.id').onDelete('cascade')
    )
    .addColumn('user_id', 'text', col =>
      col.references('users.id').onDelete('set null')
    )
    .addColumn('filename', 'text', col => col.notNull().unique())
    .addColumn('duration_s', 'integer', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .execute();
}

async function createPresenceLogTable(db: Db): Promise<void> {
  await db.schema
    .createTable('presence_log')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('status', 'text', col =>
      col.notNull().check(sql`status in ('available','busy','offline','dnd')`)
    )
    .addColumn('peer', 'text')
    .addColumn('ring_group_id', 'text', col =>
      col.references('ring_groups.id').onDelete('set null')
    )
    .addColumn('since', 'text', col => col.notNull())
    .execute();
}

// update_state — the one row of what `api` knows about updates beyond the updater's own record
// (§6.3 "Updates"), created with its row so readers need no seed.
async function createUpdateStateTable(db: Db): Promise<void> {
  await db.schema
    .createTable('update_state')
    .addColumn('id', 'integer', col => col.primaryKey().check(sql`id = 1`))
    .addColumn('run_trigger', 'text', col =>
      col.check(sql`run_trigger in ('manual','automatic')`)
    )
    .addColumn('run_actor_name', 'text')
    .addColumn('run_started_at', 'text')
    .addColumn('run_outcome_pending', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`run_outcome_pending in (0,1)`)
    )
    .addColumn('auto_failed_version', 'text')
    .addColumn('auto_failure', 'text')
    .addColumn('auto_failed_at', 'text')
    .addColumn('auto_failed_attempts', 'integer', col =>
      col.notNull().defaultTo(0)
    )
    .addColumn('breaking_version', 'text')
    .addColumn('breaking_announced', 'text')
    .addCheckConstraint(
      'update_state_auto_failure',
      sql`(auto_failed_version IS NULL) = (auto_failure IS NULL) AND (auto_failure IS NULL) = (auto_failed_at IS NULL) AND (auto_failed_at IS NULL) = (auto_failed_attempts = 0)`
    )
    .execute();
  await db.insertInto('update_state').values({ id: 1 }).execute();
}

// maintenance_gate — the maintenance gate's last give-up per piece of work it holds (§6.4).
async function createMaintenanceGateTable(db: Db): Promise<void> {
  await db.schema
    .createTable('maintenance_gate')
    .addColumn('work', 'text', col =>
      col
        .primaryKey()
        .notNull()
        .check(sql`work in ('certSync','autoUpdate')`)
    )
    .addColumn('gave_up_at', 'text', col => col.notNull())
    .addColumn('reason', 'text', col => col.notNull())
    .addColumn('consecutive_give_ups', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`consecutive_give_ups >= 0`)
    )
    .execute();
}

// Hot-path indexes beyond the implicit PK/UNIQUE ones, split so each stays short.
async function createCallIndexes(db: Db): Promise<void> {
  await db.schema
    .createIndex('calls_started')
    .on('calls')
    .column('started_at')
    .execute();
  await db.schema
    .createIndex('calls_caller')
    .on('calls')
    .columns(['caller_user_id', 'started_at'])
    .execute();
  await db.schema
    .createIndex('calls_callee')
    .on('calls')
    .columns(['callee_user_id', 'started_at'])
    .execute();
  await db.schema
    .createIndex('calls_answered_by')
    .on('calls')
    .columns(['answered_by_user_id', 'started_at'])
    .execute();
  await db.schema
    .createIndex('calls_parent')
    .on('calls')
    .column('parent_call_id')
    .execute();
  await db.schema
    .createIndex('calls_ring_group')
    .on('calls')
    .columns(['ring_group_id', 'started_at'])
    .execute();
}

async function createRemainingHotPathIndexes(db: Db): Promise<void> {
  await db.schema
    .createIndex('voicemails_user')
    .on('voicemails')
    .columns(['mailbox_user_id', 'created_at'])
    .execute();
  await db.schema
    .createIndex('voicemails_ring_group')
    .on('voicemails')
    .columns(['mailbox_ring_group_id', 'created_at'])
    .execute();
  await db.schema
    .createIndex('presence_user')
    .on('presence_log')
    .columns(['user_id', 'since'])
    .execute();
  await db.schema
    .createIndex('audit_entity')
    .on('audit_log')
    .columns(['entity_kind', 'entity_id', 'created_at'])
    .execute();
  await db.schema
    .createIndex('audit_created')
    .on('audit_log')
    .column('created_at')
    .execute();
  await db.schema
    .createIndex('audit_actor')
    .on('audit_log')
    .columns(['actor_user_id', 'created_at'])
    .execute();
  await db.schema
    .createIndex('tokens_expiry')
    .on('tokens')
    .column('expires_at')
    .execute();
  await db.schema
    .createIndex('contact_phones_number')
    .on('contact_phones')
    .column('number')
    .execute();
  await db.schema
    .createIndex('backup_runs_target')
    .on('backup_runs')
    .columns(['target_id', 'started_at'])
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

// Integrity triggers (§11.1): the did_blocks / user_group_groups guards. Raw `sql` statements are
// used only here, for the four triggers the schema builder cannot express.
async function createDidBlockGuardTriggers(db: Db): Promise<void> {
  await sql`
    CREATE TRIGGER did_blocks_soft_delete_guard BEFORE UPDATE OF deleted_at ON did_blocks
      WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM dids WHERE deleted_at IS NULL AND number GLOB NEW.base || '*'
          AND (NEW.digits IS NULL OR length(number) = length(NEW.base) + NEW.digits))
    BEGIN
      SELECT RAISE(ABORT, 'did_blocks: live DIDs within the block');
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER did_blocks_purge_guard BEFORE DELETE ON did_blocks
      WHEN EXISTS (
        SELECT 1 FROM dids WHERE deleted_at IS NULL AND number GLOB OLD.base || '*'
          AND (OLD.digits IS NULL OR length(number) = length(OLD.base) + OLD.digits))
    BEGIN
      SELECT RAISE(ABORT, 'did_blocks: live DIDs within the block');
    END
  `.execute(db);
}

async function createUserGroupGroupsTriggers(db: Db): Promise<void> {
  await sql`
    CREATE TRIGGER user_group_groups_no_cycle BEFORE INSERT ON user_group_groups
      WHEN NEW.parent_group_id = NEW.child_group_id OR EXISTS (
        WITH RECURSIVE reach(id) AS (
          SELECT NEW.child_group_id
          UNION
          SELECT g.child_group_id FROM user_group_groups g JOIN reach ON g.parent_group_id = reach.id
        )
        SELECT 1 FROM reach WHERE id = NEW.parent_group_id)
    BEGIN
      SELECT RAISE(ABORT, 'user_group_groups: cycle');
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER user_group_groups_immutable BEFORE UPDATE ON user_group_groups
    BEGIN
      SELECT RAISE(ABORT, 'user_group_groups: edges are inserted and deleted, never updated');
    END
  `.execute(db);
}

// The single tenant-wide opening_hours row (§11.1).
async function createOpeningHoursTenantSingleIndex(db: Db): Promise<void> {
  await db.schema
    .createIndex('opening_hours_tenant_single')
    .on('opening_hours')
    .unique()
    .column(sql`(1)`)
    .where(sql.ref('scope_user_id'), 'is', null)
    .where(sql.ref('scope_ring_group_id'), 'is', null)
    .where(sql.ref('scope_menu_id'), 'is', null)
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

export async function up(db: Db): Promise<void> {
  await createUsersTable(db);
  await createUsersIndexes(db);
  await createDevicesTable(db);
  await createDeviceBlfKeysTable(db);
  await createTrunksTable(db);
  await createTrunksIndexes(db);
  await createTrunkHostsTable(db);
  await createOutboundRoutesTable(db);
  await createOutboundRouteUsersTable(db);
  await createOutboundRouteUserGroupsTable(db);
  await createOutboundRouteNumbersTable(db);
  await createDidBlocksTable(db);
  await createDidsTable(db);
  await createRingGroupsTable(db);
  await createRingGroupMembersTable(db);
  await createUserGroupsTable(db);
  await createUserGroupUsersTable(db);
  await createUserGroupGroupsTable(db);
  await createExtensionsTable(db);
  await createForwardTargetsTable(db);
  await createMenusTable(db);
  await createMenuTargetsTable(db);
  await createUserForwardRulesTable(db);
  await createRingGroupForwardRulesTable(db);
  await createSettingsTable(db);
  await createOooRulesTable(db);
  await createOpeningHoursTable(db);
  await createOpeningHoursIndexes(db);
  await createOpeningHoursIntervalsTable(db);
  await createAudioAssetsTable(db);
  await createBlockedNumbersTable(db);
  await createMailTemplatesTable(db);
  await createContactsTable(db);
  await createContactPhonesTable(db);
  await createOauthClientsTable(db);
  await createTokensTable(db);
  await createWebhooksTable(db);
  await createWebhookDeliveriesTable(db);
  await createBackupTargetsTable(db);
  await createBackupRunsTable(db);
  await createAuditLogTable(db);
  await createCallsTable(db);
  await createCallQosTable(db);
  await createVoicemailsTable(db);
  await createRecordingsTable(db);
  await createPresenceLogTable(db);
  await createUpdateStateTable(db);
  await createMaintenanceGateTable(db);
  await createCallIndexes(db);
  await createRemainingHotPathIndexes(db);
  await createDidBlockGuardTriggers(db);
  await createUserGroupGroupsTriggers(db);
  await createOpeningHoursTenantSingleIndex(db);
}

export async function down(db: Db): Promise<void> {
  for (const table of [...TABLE_NAMES].reverse()) {
    // eslint-disable-next-line no-await-in-loop -- tables drop one at a time, in reverse creation order
    await db.schema.dropTable(table).ifExists().execute();
  }
}
