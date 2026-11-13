/**
 * Ending a user's sign-ins (§5.2): what a redeemed password reset, an MFA reset and the soft
 * delete of a user share, in the caller's transaction, here so that the host command
 * `reset-mfa.mjs` runs it too.
 */
import type { Db } from './db.js';

/**
 * Bumps `userId`'s `credential_epoch`, which everything a sign-in issues before its session
 * carries and is refused by once it differs, and revokes their live refresh tokens (their
 * sessions) and the personal access tokens they hold; tokens they created for others stay.
 */
export async function endSignIns(
  db: Db,
  userId: string,
  now: string
): Promise<void> {
  await db
    .updateTable('users')
    .set(eb => ({ credentialEpoch: eb('credentialEpoch', '+', 1) }))
    .where('id', '=', userId)
    .execute();
  await db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('userId', '=', userId)
    .where('kind', '=', 'refresh')
    .where('revokedAt', 'is', null)
    .execute();
  await db
    .updateTable('personalAccessTokens')
    .set({ revokedAt: now })
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .execute();
}

/** The `credential_epoch` of live user `userId`, `null` for a deleted or unknown one. */
export async function credentialEpoch(
  db: Db,
  userId: string
): Promise<number | null> {
  const row = await db
    .selectFrom('users')
    .select('credentialEpoch')
    .where('id', '=', userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return row?.credentialEpoch ?? null;
}
