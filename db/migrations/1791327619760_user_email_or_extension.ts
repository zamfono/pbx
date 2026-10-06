import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// users — a user needs an e-mail or an extension, or both; an owner or admin needs an e-mail
// (§11.2). The e-mail is NULL for a phone-only user, who cannot log in. The extension lives in
// `extensions`, beyond a CHECK's reach, so two triggers refuse what would leave a live user with
// neither: the e-mail going while no extension row exists, and the extension row going while the
// e-mail is NULL. A soft delete marks the row first, so its cascade passes.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('users')
    .alterColumn('email', col => col.dropNotNull())
    .execute();
  await db.schema
    .alterTable('users')
    .addCheckConstraint(
      'users_staff_email',
      sql`email is not null or role = 'user'`
    )
    .execute();
  await sql`
    CREATE TRIGGER users_email_or_extension BEFORE UPDATE OF email ON users
      WHEN NEW.email IS NULL AND NEW.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM extensions WHERE user_id = NEW.id)
    BEGIN
      SELECT RAISE(ABORT, 'users: a user needs an e-mail or an extension');
    END
  `.execute(db);
  await sql`
    CREATE TRIGGER extensions_user_email_or_extension BEFORE DELETE ON extensions
      WHEN EXISTS (
        SELECT 1 FROM users WHERE id = OLD.user_id AND email IS NULL AND deleted_at IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'users: a user needs an e-mail or an extension');
    END
  `.execute(db);
}
