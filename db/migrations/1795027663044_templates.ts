import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// Templates (§9.4 "Templates", §11.2): an `external` target's number and a `sip` target's user
// part may be templates, the new kind `extension` is one (`forward_targets.extension`), and a
// decision takes the condition `template`. A column's CHECK changes by copying the column into a
// new one, and the checks that read a column to be dropped go first and come back by name.

/** Replaces `column` of `table` by a copy without its CHECK, `NOT NULL DEFAULT 0` where the
 * column was (SQLite adds a default only with the column). */
async function withoutColumnCheck(
  db: Db,
  table: string,
  column: string,
  type: 'text' | 'integer',
  flag = false
): Promise<void> {
  const next = `${column}_next`;
  await db.schema
    .alterTable(table)
    .addColumn(next, type, col => (flag ? col.notNull().defaultTo(0) : col))
    .execute();
  await db
    .updateTable(table)
    .set({ [next]: sql.ref(column) })
    .execute();
  await db.schema.alterTable(table).dropColumn(column).execute();
  await db.schema.alterTable(table).renameColumn(next, column).execute();
}

async function templatedForwardTargets(db: Db): Promise<void> {
  for (const name of ['forward_targets_one_kind', 'forward_targets_sip_pair']) {
    // eslint-disable-next-line no-await-in-loop -- one statement after the other
    await db.schema
      .alterTable('forward_targets')
      .dropConstraint(name)
      .execute();
  }
  // `record_calls` and `ring_timeout_s` read `external` in their own CHECKs, so they go first.
  await withoutColumnCheck(
    db,
    'forward_targets',
    'record_calls',
    'integer',
    true
  );
  await withoutColumnCheck(db, 'forward_targets', 'ring_timeout_s', 'integer');
  await withoutColumnCheck(db, 'forward_targets', 'external', 'text');
  await withoutColumnCheck(db, 'forward_targets', 'sip_user', 'text');
  await db.schema
    .alterTable('forward_targets')
    .addColumn('extension', 'text')
    .execute();
  const checks = [
    [
      'forward_targets_external',
      sql`external is null or instr(external, '{{') > 0
      or (external glob '+[0-9]*' and substr(external, 2) not glob '*[^0-9]*')`
    ],
    [
      'forward_targets_sip_user',
      sql`sip_user is null or instr(sip_user, '{{') > 0
      or (length(sip_user) between 1 and 64 and sip_user not glob '*[^A-Za-z0-9._~+-]*')`
    ],
    [
      'forward_targets_extension',
      sql`extension is null or instr(extension, '{{') > 0`
    ],
    [
      'forward_targets_sip_pair',
      sql`(sip_trunk_id is null) = (sip_user is null)`
    ],
    [
      'forward_targets_record_calls',
      sql`record_calls in (0,1) and (record_calls = 0
      or external is not null or sip_trunk_id is not null or web_socket_url is not null)`
    ],
    [
      'forward_targets_ring_timeout',
      sql`ring_timeout_s is null or (ring_timeout_s between 1 and 86400
      and (external is not null or sip_trunk_id is not null))`
    ],
    [
      'forward_targets_one_kind',
      sql`(user_id is not null) + (ring_group_id is not null) + (external is not null) +
             (sip_trunk_id is not null) + (web_socket_url is not null) +
             (mailbox_user_id is not null) + (mailbox_ring_group_id is not null) +
             (menu_id is not null) + (decision_id is not null) + (extension is not null) <= 1`
    ]
  ] as const;
  for (const [name, check] of checks) {
    // eslint-disable-next-line no-await-in-loop -- one statement after the other
    await db.schema
      .alterTable('forward_targets')
      .addCheckConstraint(name, check)
      .execute();
  }
}

async function templateCondition(db: Db): Promise<void> {
  const constraints = [
    [
      'decision_conditions_operator_payload',
      sql`type not in ('any','all','not') or value_json is null`
    ],
    [
      'decision_conditions_user',
      sql`case type when 'presence' then user_id is not null when 'callerUser' then 1 else user_id is null end`
    ]
  ] as const;
  for (const [name] of constraints) {
    // eslint-disable-next-line no-await-in-loop -- one statement after the other
    await db.schema
      .alterTable('decision_conditions')
      .dropConstraint(name)
      .execute();
  }
  await withoutColumnCheck(db, 'decision_conditions', 'type', 'text');
  await sql`alter table decision_conditions alter column type set not null`.execute(
    db
  );
  for (const [name, check] of [
    [
      'decision_conditions_type',
      sql`type in ('schedule','dates','caller','callerUser','presence','template','any','all','not')`
    ],
    ...constraints
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one statement after the other
    await db.schema
      .alterTable('decision_conditions')
      .addCheckConstraint(name, check)
      .execute();
  }
}

export async function up(db: Db): Promise<void> {
  await templatedForwardTargets(db);
  await templateCondition(db);
}
