/**
 * Recovery codes (§5.2 "Two-factor authentication", §11.2 `recovery_codes`): ten single-use codes
 * that pass the second step once each, for a person who lost their other methods. Each is stored
 * as its SHA-256 hash; 80 random bits make guessing one infeasible, so no slow hash is needed.
 */
import { randomBytes } from 'node:crypto';

import { newId, type Db } from '@zamfono/shared';

import { sha256Hex } from '#lib/server/hash.js';

import { base32Encode } from './totp.js';

const CODE_COUNT = 10;
const CODE_BYTES = 10;
const GROUP = 4;
const NO_ROWS = 0n;

/** `code` as typed, reduced to the characters that carry it: case and separators do not count. */
function normalized(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z2-7]/gu, '');
}

/** A fresh code, base32 in dash-separated groups of four, `ABCD-EFGH-IJKL-MNOP`. */
function newCode(): string {
  const raw = base32Encode(randomBytes(CODE_BYTES));
  return raw.match(new RegExp(`.{${GROUP}}`, 'gu'))?.join('-') ?? raw;
}

/** Replaces `userId`'s recovery codes with ten fresh ones and returns them, the only time they
 *  are ever readable. */
export async function issueRecoveryCodes(
  db: Db,
  userId: string,
  now: string
): Promise<string[]> {
  const codes = Array.from({ length: CODE_COUNT }, newCode);
  await db.deleteFrom('recoveryCodes').where('userId', '=', userId).execute();
  await db
    .insertInto('recoveryCodes')
    .values(
      codes.map(code => ({
        id: newId(),
        userId,
        codeHash: sha256Hex(normalized(code)),
        createdAt: now
      }))
    )
    .execute();
  return codes;
}

/** Whether `code` is one of `userId`'s unused recovery codes, using it up. */
export async function redeemRecoveryCode(
  db: Db,
  userId: string,
  code: string
): Promise<boolean> {
  const { numDeletedRows } = await db
    .deleteFrom('recoveryCodes')
    .where('userId', '=', userId)
    .where('codeHash', '=', sha256Hex(normalized(code)))
    .executeTakeFirst();
  return numDeletedRows > NO_ROWS;
}
