import { createHash, randomBytes } from 'node:crypto';

import type { Db } from '@zamfono/shared';

// §11.2 `tokens`: refresh tokens rotate every 30 days, a setup link is valid 7 days, a
// self-requested reset link 1 hour.
const RAW_TOKEN_BYTES = 32;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const REFRESH_TOKEN_TTL_DAYS = 30;
const SETUP_TOKEN_TTL_DAYS = 7;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * DAY_MS;
const SETUP_TOKEN_TTL_MS = SETUP_TOKEN_TTL_DAYS * DAY_MS;
const RESET_TOKEN_TTL_MS = HOUR_MS;

/** SHA-256 hex of `raw`; the only form a refresh or reset token is ever stored in (§5.2, §11.2). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** Issues a 30-day refresh token for `userId`/`clientId`, returning the raw value once. */
export async function issueRefresh(
  db: Db,
  userId: string,
  clientId: string,
  now: string
): Promise<{ raw: string; expiresAt: string }> {
  const raw = generateRawToken();
  const expiresAt = addMs(now, REFRESH_TOKEN_TTL_MS);
  await db
    .insertInto('tokens')
    .values({
      tokenHash: hashToken(raw),
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
 * (§5.2): every refresh token of that user and client is revoked, per OAuth 2.1.
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
  const tokenHash = hashToken(raw);
  const row = await db
    .selectFrom('tokens')
    .select(['userId', 'clientId', 'expiresAt', 'revokedAt'])
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
  if (row.revokedAt !== null) {
    await revokeUserTokens(db, row.userId, now, row.clientId);
    return { ok: false, reason: 'replayed' };
  }
  await db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('tokenHash', '=', tokenHash)
    .execute();
  const next = await issueRefresh(db, row.userId, row.clientId, now);
  return { ok: true, userId: row.userId, clientId: row.clientId, next };
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
  const expiresAt = addMs(now, ttlMs);
  await db
    .insertInto('tokens')
    .values({
      tokenHash: hashToken(raw),
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

/** Redeems a set-password token: a redeemed, expired or unknown token fails; success revokes it. */
export async function redeemResetToken(
  db: Db,
  raw: string,
  now: string
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const tokenHash = hashToken(raw);
  const row = await db
    .selectFrom('tokens')
    .select(['userId', 'expiresAt', 'revokedAt'])
    .where('tokenHash', '=', tokenHash)
    .where('kind', '=', 'reset')
    .executeTakeFirst();
  if (!row) {
    return { ok: false };
  }
  if (row.revokedAt !== null || row.expiresAt <= now) {
    return { ok: false };
  }
  await db
    .updateTable('tokens')
    .set({ revokedAt: now })
    .where('tokenHash', '=', tokenHash)
    .execute();
  return { ok: true, userId: row.userId };
}
