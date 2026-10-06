import type { Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// users — an owner may exist without a password: one an owner creates, or a promoted SSO-only
// user, who cannot log in until they set one through their set-password link (§5.2, §11.2).
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('users')
    .dropConstraint('users_owner_password_hash')
    .execute();
}
