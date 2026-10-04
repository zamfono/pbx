import { randomBytes } from 'node:crypto';
import type { NotNull } from 'kysely';

import { addMsIso, MS_PER_DAY, MS_PER_HOUR, type Db } from '@zamfono/shared';

import { sha256Hex } from '../hash.js';

// §11.2 `tokens`: refresh tokens live 30 days and rotate on every use, a setup link is valid 7 days, a
// self-requested reset link 1 hour.
const RAW_TOKEN_BYTES = 32;
const REFRESH_TOKEN_TTL_DAYS = 30;
const SETUP_TOKEN_TTL_DAYS = 7;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY;
const SETUP_TOKEN_TTL_MS = SETUP_TOKEN_TTL_DAYS * MS_PER_DAY;
const RESET_TOKEN_TTL_MS = MS_PER_HOUR;

function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

/** Issues a 30-day refresh token for `userId`/`clientId`, returning the raw value once. */
export async function issueRefresh(
  db: Db,
  userId: string,
  clientId: string,
  now: string
): Promise<{ raw: string; expiresAt: string }> {
  const raw = generateRawToken();
  const expiresAt = addMsIso(now, REFRESH_TOKEN_TTL_MS);
  await db
    .insertInto('tokens')
    .values({
      tokenHash: sha256Hex(raw),
      userId,
      kind: 'refresh',
      clientId,
      createdAt: now,
      expiresAt,
      revokedAt: null
    })
    .execute();
  return { raw, expiresAt };
}

/**
 * Revokes every live refresh token of `userId`, or only those for `clientId` when given
 * (§5.2: a rotation replay revokes the pair's tokens; a password reset revokes every session).
 */
export async function revokeUserTokens(
  db: Db,
  userId: string,
  now: string,
  clientId?: string
): Promise<void> {
  const base = db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('userId', '=', userId)
    .where('kind', '=', 'refresh')
    .where('revokedAt', 'is', null);
  const query =
    clientId === undefined ? base : base.where('clientId', '=', clientId);
  await query.execute();
}

/**
 * Redeems and rotates a refresh token. A revoked token being presented again is a replay
 * (§5.2): every refresh token of that user and client is revoked, per OAuth 2.1. The redemption
 * is the guarded revoke itself, so of two requests presenting the same token only one rotates it.
 */
export async function rotateRefresh(
  db: Db,
  raw: string,
  now: string
): Promise<
  | {
      ok: true;
      userId: string;
      clientId: string;
      next: { raw: string; expiresAt: string };
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'replayed' }
> {
  const tokenHash = sha256Hex(raw);
  const claimed = await db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('tokenHash', '=', tokenHash)
    .where('kind', '=', 'refresh')
    .where('clientId', 'is not', null)
    .where('revokedAt', 'is', null)
    .where('expiresAt', '>', now)
    .returning(['userId', 'clientId'])
    .$narrowType<{ clientId: NotNull }>()
    .executeTakeFirst();
  if (claimed) {
    const next = await issueRefresh(db, claimed.userId, claimed.clientId, now);
    return {
      ok: true,
      userId: claimed.userId,
      clientId: claimed.clientId,
      next
    };
  }
  const row = await db
    .selectFrom('tokens')
    .select(['userId', 'clientId', 'expiresAt'])
    .where('tokenHash', '=', tokenHash)
    .where('kind', '=', 'refresh')
    .executeTakeFirst();
  if (!row) {
    return { ok: false, reason: 'unknown' };
  }
  if (row.clientId === null) {
    return { ok: false, reason: 'unknown' };
  }
  // Expiry is checked first: the daily purge keeps an expired refresh row 30 more days as its
  // client's last-expiry record (§5.2 "Client rows"), but replay detection only covers a row's
  // life until it expires (§5.2 "Tokens"), so an expired revoked token is expired, not a replay.
  if (row.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }
  await revokeUserTokens(db, row.userId, now, row.clientId);
  return { ok: false, reason: 'replayed' };
}

/** Issues a single-use set-password token: 7 days for a setup link, 1 hour for a reset link. */
export async function issueResetToken(
  db: Db,
  userId: string,
  kind: 'setup' | 'reset',
  now: string
): Promise<{ raw: string; expiresAt: string }> {
  const ttlMs = kind === 'setup' ? SETUP_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;
  const raw = generateRawToken();
  const expiresAt = addMsIso(now, ttlMs);
  await db
    .insertInto('tokens')
    .values({
      tokenHash: sha256Hex(raw),
      userId,
      kind: 'reset',
      clientId: null,
      createdAt: now,
      expiresAt,
      revokedAt: null
    })
    .execute();
  return { raw, expiresAt };
}

/** The user a set-password token redeems for, `null` for a redeemed, expired or unknown one. */
export async function liveResetTokenUser(
  db: Db,
  raw: string,
  now: string
): Promise<string | null> {
  const row = await db
    .selectFrom('tokens')
    .select('userId')
    .where('tokenHash', '=', sha256Hex(raw))
    .where('kind', '=', 'reset')
    .where('revokedAt', 'is', null)
    .where('expiresAt', '>', now)
    .executeTakeFirst();
  return row?.userId ?? null;
}

/** Redeems a set-password token: a redeemed, expired or unknown token fails; success revokes it.
 *  The redemption is the guarded revoke itself, so a token presented twice at once redeems once. */
export async function redeemResetToken(
  db: Db,
  raw: string,
  now: string
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const claimed = await db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('tokenHash', '=', sha256Hex(raw))
    .where('kind', '=', 'reset')
    .where('revokedAt', 'is', null)
    .where('expiresAt', '>', now)
    .returning('userId')
    .executeTakeFirst();
  return claimed ? { ok: true, userId: claimed.userId } : { ok: false };
}
