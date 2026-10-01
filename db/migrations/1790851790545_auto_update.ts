import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// Automatic updates (§6.3 "Updates", §11.2, §11.4):
// - settings.auto_update, the owner's opt-in, added at 0 so no stack updates itself unasked;
//   SQLite's `ADD COLUMN` takes a NOT NULL column with a default and a CHECK.
// - update_state, the one row of what `api` knows about updates beyond the updater's own record:
//   who asked for the last run it started, the last automatic attempt's failure with the count of
//   failed attempts on that release, and the breaking release last seen and announced. Created
//   with its row, all NULL and 0, so readers need no seed.
// - mail_templates.kind admits the two new mails, updateFailed and breakingUpdate. SQLite cannot
//   alter a CHECK, so the table is rebuilt: created under a new name, filled, the old one dropped
//   and the new one renamed. Nothing references mail_templates, so no foreign key is touched.
// Kysely runs a SQLite migration outside a transaction, so `up` and `down` each open their own:
// a failure leaves nothing half-done for the migrate service's next run to trip over.

const KINDS_BEFORE = ['voicemail', 'missedCall', 'setup', 'reset'];
const KINDS_AFTER = [...KINDS_BEFORE, 'updateFailed', 'breakingUpdate'];

async function createMailTemplates(
  db: Db,
  name: string,
  kinds: string[]
): Promise<void> {
  await db.schema
    .createTable(name)
    .addColumn('kind', 'text', col =>
      col
        .notNull()
        .check(sql`kind in (${sql.join(kinds.map(kind => sql.lit(kind)))})`)
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

/** Rebuilds mail_templates with `kinds`, keeping every override whose kind is among them. */
async function rebuildMailTemplates(db: Db, kinds: string[]): Promise<void> {
  await createMailTemplates(db, 'mail_templates_next', kinds);
  await sql`INSERT INTO mail_templates_next
            SELECT kind, language, subject, body_text, body_html, updated_at
            FROM mail_templates
            WHERE kind IN (${sql.join(kinds.map(kind => sql.lit(kind)))})`.execute(
    db
  );
  await db.schema.dropTable('mail_templates').execute();
  await db.schema
    .alterTable('mail_templates_next')
    .renameTo('mail_templates')
    .execute();
}

async function addAutoUpdate(db: Db): Promise<void> {
  await db.schema
    .alterTable('settings')
    .addColumn('auto_update', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`auto_update in (0,1)`)
    )
    .execute();
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
  await rebuildMailTemplates(db, KINDS_AFTER);
}

async function removeAutoUpdate(db: Db): Promise<void> {
  await rebuildMailTemplates(db, KINDS_BEFORE);
  await db.schema.dropTable('update_state').execute();
  await db.schema.alterTable('settings').dropColumn('auto_update').execute();
}

export async function up(db: Db): Promise<void> {
  await db.transaction().execute(addAutoUpdate);
}

export async function down(db: Db): Promise<void> {
  await db.transaction().execute(removeAutoUpdate);
}
