import type { Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// webauthn_credentials — a user's passkeys, a second factor of a password login (§5.2
// "Two-factor authentication", §11.2).
export async function up(db: Db): Promise<void> {
  await db.schema
    .createTable('webauthn_credentials')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('user_id', 'text', col =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('credential_id', 'text', col => col.notNull().unique())
    .addColumn('public_key', 'blob', col => col.notNull())
    .addColumn('sign_count', 'integer', col => col.notNull())
    .addColumn('transports_json', 'text')
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('last_used_at', 'text')
    .execute();
  await db.schema
    .createIndex('webauthn_credentials_user')
    .on('webauthn_credentials')
    .column('user_id')
    .execute();
}
