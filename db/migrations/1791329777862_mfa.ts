import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// totp_credentials, recovery_codes — a user's authenticator app and single-use recovery codes,
// the second factor of a password login (§5.2 "Two-factor authentication", §11.2).
async function createMfaTables(db: Db): Promise<void> {
  await db.schema
    .createTable('totp_credentials')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.notNull().unique().references('users.id').onDelete('cascade')
    )
    .addColumn('secret_enc', 'blob', col => col.notNull())
    .addColumn('last_step', 'integer', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .execute();
  await db.schema
    .createTable('recovery_codes')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('code_hash', 'text', col => col.notNull().unique())
    .addColumn('created_at', 'text', col => col.notNull())
    .execute();
  await db.schema
    .createIndex('recovery_codes_user')
    .on('recovery_codes')
    .column('user_id')
    .execute();
}

// mail_templates — the kind CHECK gains `mfaChanged` (§10.2 "Mail"). SQLite cannot alter a CHECK,
// so the table is rebuilt with its rows; nothing references it.
async function addMfaMailKind(db: Db): Promise<void> {
  await db.schema
    .createTable('mail_templates_next')
    .addColumn('kind', 'text', col =>
      col
        .notNull()
        .check(
          sql`kind in ('voicemail','missedCall','setup','reset','updateFailed','breakingUpdate','mfaChanged')`
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
  await sql`INSERT INTO mail_templates_next SELECT kind, language, subject, body_text, body_html, updated_at FROM mail_templates`.execute(
    db
  );
  await db.schema.dropTable('mail_templates').execute();
  await db.schema
    .alterTable('mail_templates_next')
    .renameTo('mail_templates')
    .execute();
}

export async function up(db: Db): Promise<void> {
  await createMfaTables(db);
  // settings — 1 = every user needs a second factor, not only owners and admins (§11.4).
  await db.schema
    .alterTable('settings')
    .addColumn('mfa_required_for_all', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`mfa_required_for_all in (0,1)`)
    )
    .execute();
  await addMfaMailKind(db);
}
