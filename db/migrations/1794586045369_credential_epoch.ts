import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// users.credential_epoch — bumped by a redeemed password reset, an MFA reset and the soft delete;
// everything a sign-in issues carries the value read at its password step and is refused once it
// no longer matches (§5.2, §11.2).
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('credential_epoch', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`credential_epoch >= 0`)
    )
    .execute();
}
