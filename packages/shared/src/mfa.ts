/**
 * A user's second factors as stored (§5.2 "Two-factor authentication", §11.2): what they hold and
 * the one definition of removing them, shared by `api`'s operations, the soft delete of a user and
 * the host command an operator runs for an owner who lost every method
 * (`packages/api/scripts/resetMfa.mjs`).
 */
import type { Db } from './db.js';

/** What a user holds: never a secret, only flags and counts. */
export type MfaMethods = {
  totp: boolean;
  passkeys: number;
  recoveryCodesLeft: number;
};

/** `userId`'s methods. */
export async function mfaMethods(db: Db, userId: string): Promise<MfaMethods> {
  const [totp, codes] = await Promise.all([
    db
      .selectFrom('totpCredentials')
      .select('id')
      .where('userId', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('recoveryCodes')
      .select(eb => eb.fn.countAll<number>().as('n'))
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow()
  ]);
  return {
    totp: totp !== undefined,
    passkeys: 0,
    recoveryCodesLeft: codes.n
  };
}

/** Deletes every second-factor method and recovery code of `userId`. */
export async function removeMfaMethods(db: Db, userId: string): Promise<void> {
  await db.deleteFrom('totpCredentials').where('userId', '=', userId).execute();
  await db.deleteFrom('recoveryCodes').where('userId', '=', userId).execute();
}

/** Removes `userId`'s methods and codes and ends their sessions (their live refresh tokens), so
 *  every client signs in again, through enrolment where a second factor is required. Answers what
 *  the user held before. */
export async function resetMfa(
  db: Db,
  userId: string,
  now: string
): Promise<MfaMethods> {
  const before = await mfaMethods(db, userId);
  await removeMfaMethods(db, userId);
  await db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('userId', '=', userId)
    .where('kind', '=', 'refresh')
    .where('revokedAt', 'is', null)
    .execute();
  return before;
}
