import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// Decisions (§10.1 step 7 "Decision", §11.2): a node that sends a call to the first of its cases
// whose conditions all match, else to its default target. A forward target of kind `decision`
// names one (`forward_targets.decision_id`). Each condition is a row of `decision_conditions`, an
// operator's children naming it as `parent_id`, so a condition naming a user has a real foreign
// key (`user_id`). Decisions and menus also take an extension of their own (`extensions`).
// decisions — the decisions themselves.
async function createDecisionsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('decisions')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('default_target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .execute();
  await db.schema
    .createIndex('decisions_name')
    .on('decisions')
    .unique()
    .column('name')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// decision_cases — a decision's cases, in order.
async function createDecisionCasesTable(db: Db): Promise<void> {
  await db.schema
    .createTable('decision_cases')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('decision_id', 'text', col =>
      col.notNull().references('decisions.id').onDelete('cascade')
    )
    .addColumn('position', 'integer', col => col.notNull())
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addUniqueConstraint('decision_cases_position', ['decision_id', 'position'])
    .execute();
}

// decision_conditions — one row per condition, an operator's children naming it.
async function createDecisionConditionsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('decision_conditions')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('decision_id', 'text', col =>
      col.notNull().references('decisions.id').onDelete('cascade')
    )
    .addColumn('case_id', 'text', col =>
      col.notNull().references('decision_cases.id').onDelete('cascade')
    )
    .addColumn('parent_id', 'text', col =>
      col.references('decision_conditions.id').onDelete('cascade')
    )
    .addColumn('position', 'integer', col => col.notNull())
    .addColumn('type', 'text', col =>
      col
        .notNull()
        .check(
          sql`type in ('schedule','dates','caller','callerUser','presence','any','all','not')`
        )
    )
    .addColumn('value_json', 'text', col =>
      col.check(sql`value_json is null or json_valid(value_json)`)
    )
    .addColumn('user_id', 'text', col =>
      col.references('users.id').onDelete('restrict')
    )
    .addCheckConstraint(
      'decision_conditions_operator_payload',
      sql`type not in ('any','all','not') or value_json is null`
    )
    .addCheckConstraint(
      'decision_conditions_user',
      sql`case type when 'presence' then user_id is not null when 'callerUser' then 1 else user_id is null end`
    )
    .execute();
  await db.schema
    .createIndex('decision_conditions_decision')
    .on('decision_conditions')
    .column('decision_id')
    .execute();
  await db.schema
    .createIndex('decision_conditions_case')
    .on('decision_conditions')
    .column('case_id')
    .execute();
  await db.schema
    .createIndex('decision_conditions_parent')
    .on('decision_conditions')
    .column('parent_id')
    .execute();
  await db.schema
    .createIndex('decision_conditions_user')
    .on('decision_conditions')
    .column('user_id')
    .execute();
}

// forward_targets — the kind `decision`.
async function addForwardTargetDecision(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .addColumn('decision_id', 'text', col =>
      col.references('decisions.id').onDelete('restrict')
    )
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .dropConstraint('forward_targets_one_kind')
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addCheckConstraint(
      'forward_targets_one_kind',
      sql`(user_id is not null) + (ring_group_id is not null) + (external is not null) +
             (sip_trunk_id is not null) + (web_socket_url is not null) +
             (mailbox_user_id is not null) + (mailbox_ring_group_id is not null) +
             (menu_id is not null) + (decision_id is not null) <= 1`
    )
    .execute();
}

// extensions — a decision or a menu may own one.
async function addExtensionOwners(db: Db): Promise<void> {
  // SQLite adds no UNIQUE column, so each owner's uniqueness is an index of its own.
  await db.schema
    .alterTable('extensions')
    .addColumn('decision_id', 'text', col =>
      col.references('decisions.id').onDelete('cascade')
    )
    .execute();
  await db.schema
    .alterTable('extensions')
    .addColumn('menu_id', 'text', col =>
      col.references('menus.id').onDelete('cascade')
    )
    .execute();
  await db.schema
    .createIndex('extensions_decision')
    .on('extensions')
    .unique()
    .column('decision_id')
    .execute();
  await db.schema
    .createIndex('extensions_menu')
    .on('extensions')
    .unique()
    .column('menu_id')
    .execute();
  await db.schema
    .alterTable('extensions')
    .dropConstraint('extensions_one_owner')
    .execute();
  await db.schema
    .alterTable('extensions')
    .addCheckConstraint(
      'extensions_one_owner',
      sql`(user_id is not null) + (ring_group_id is not null) + (decision_id is not null) +
             (menu_id is not null) + is_parking_slot = 1`
    )
    .execute();
}

export async function up(db: Db): Promise<void> {
  await createDecisionsTable(db);
  await createDecisionCasesTable(db);
  await createDecisionConditionsTable(db);
  await addForwardTargetDecision(db);
  await addExtensionOwners(db);
}
