/**
 * Personal access tokens (§5.2 "Personal access tokens"): an opaque bearer token a server
 * application presents in place of an access token, acting as the user it was created for.
 */
import type { ExpressionBuilder } from 'kysely';

import { addMsIso, MS_PER_MINUTE, type DB, type Db } from '@zamfono/shared';

import { sha256Hex } from '../hash.js';
import { generateRawToken } from './tokens.js';

/** What sets a personal access token apart from a JWT access token on the same bearer header. */
export const PAT_PREFIX = 'zpat_';

// §5.2: `last_used_at` is written at most once a minute per token, so a busy application costs
// one write a minute rather than one per request.
const LAST_USED_RESOLUTION_MS = MS_PER_MINUTE;

/** The token a request authenticated with, which an `/events` socket opened with it lives by (§10.6). */
export type PersonalAccessTokenGrant = { id: string; expiresAt: string | null };

/** A new personal access token: the raw value, returned once, and the hash that is stored. */
export function newPersonalAccessToken(): { raw: string; tokenHash: string } {
  const raw = `${PAT_PREFIX}${generateRawToken()}`;
  return { raw, tokenHash: sha256Hex(raw) };
}

/** The live tokens at `now`: neither revoked nor past `expires_at`. */
function liveAt(now: string) {
  return (eb: ExpressionBuilder<DB, 'personalAccessTokens'>) =>
    eb.and([
      eb('revokedAt', 'is', null),
      eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)])
    ]);
}

/**
 * Personal access token `raw` and the user it acts as, `null` for an unknown, revoked or expired
 * one. Records the use in `last_used_at` when the stored time is more than a minute old.
 */
export async function livePersonalAccessToken(
  db: Db,
  raw: string,
  now: string
): Promise<(PersonalAccessTokenGrant & { userId: string }) | null> {
  const row = await db
    .selectFrom('personalAccessTokens')
    .select(['id', 'userId', 'expiresAt', 'lastUsedAt'])
    .where('tokenHash', '=', sha256Hex(raw))
    .where(liveAt(now))
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const stale = addMsIso(now, -LAST_USED_RESOLUTION_MS);
  if (row.lastUsedAt === null || row.lastUsedAt <= stale) {
    await db
      .updateTable('personalAccessTokens')
      .set({ lastUsedAt: now })
      .where('id', '=', row.id)
      .execute();
  }
  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
}

/** Which of the tokens `ids` are still live at `now`. */
export async function livePersonalAccessTokenIds(
  db: Db,
  ids: readonly string[],
  now: string
): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectFrom('personalAccessTokens')
    .select('id')
    .where('id', 'in', ids)
    .where(liveAt(now))
    .execute();
  return new Set(rows.map(row => row.id));
}

/** Revokes every live personal access token of `userId` (§5.9: a soft-deleted user's). */
export async function revokeUserPersonalAccessTokens(
  db: Db,
  userId: string,
  now: string
): Promise<void> {
  await db
    .updateTable('personalAccessTokens')
    .set({ revokedAt: now })
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .execute();
}
