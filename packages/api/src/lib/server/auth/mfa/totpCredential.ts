/**
 * A user's authenticator app (§5.2 "Two-factor authentication", §11.2 `totp_credentials`): the
 * secret, encrypted at rest (§5.4), and the step of the code last accepted, so no code is
 * accepted twice.
 */
import { newId, type Db } from '@zamfono/shared';

import { decrypt, encrypt, type Keyring } from '#lib/server/secretbox.js';

import { matchTotp } from './totp.js';

const PURPOSE = 'totpCredentials.secretEnc';
const NO_ROWS = 0n;

/** Stores `secret` as `userId`'s authenticator app, replacing any earlier one; `step` is the step
 *  of the code that confirmed it, so that code cannot sign in afterwards. */
export async function saveTotp(
  db: Db,
  kr: Keyring,
  { userId, secret, step }: { userId: string; secret: Buffer; step: number },
  now: string
): Promise<void> {
  await db.deleteFrom('totpCredentials').where('userId', '=', userId).execute();
  await db
    .insertInto('totpCredentials')
    .values({
      id: newId(),
      userId,
      secretEnc: encrypt(kr, PURPOSE, secret),
      lastStep: step,
      createdAt: now
    })
    .execute();
}

/**
 * Whether `code` is a valid TOTP code of `userId`'s authenticator app at `nowMs`, consuming its
 * step: the step is recorded in the same guarded write that accepts it, so of two requests with
 * the same code only one passes.
 */
export async function verifyTotp(
  db: Db,
  kr: Keyring,
  userId: string,
  code: string,
  nowMs: number
): Promise<boolean> {
  const row = await db
    .selectFrom('totpCredentials')
    .select(['secretEnc', 'lastStep'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) {
    return false;
  }
  const secret = decrypt(kr, PURPOSE, row.secretEnc);
  const step = matchTotp(secret, code, nowMs, row.lastStep);
  if (step === null) {
    return false;
  }
  const { numUpdatedRows } = await db
    .updateTable('totpCredentials')
    .set({ lastStep: step })
    .where('userId', '=', userId)
    .where('lastStep', '<', step)
    .executeTakeFirst();
  return numUpdatedRows > NO_ROWS;
}

/** Removes `userId`'s authenticator app. */
export async function removeTotp(db: Db, userId: string): Promise<void> {
  await db.deleteFrom('totpCredentials').where('userId', '=', userId).execute();
}
