import type { Selectable } from 'kysely';
import { z } from 'zod';

import { HTTP_NOT_FOUND, type DB, type Db } from '@zamfono/shared';

import { OpError, type Context } from '../types.js';
import { namesAnOwner } from '../users/_shared.js';

export type PersonalAccessTokenRow = Selectable<DB['personalAccessTokens']>;

/** A personal access token's wire shape (§5.2, §10.3 "Users"): everything but its value. */
export const personalAccessTokenWire = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable()
});

export function toPersonalAccessTokenWire(
  row: PersonalAccessTokenRow
): z.infer<typeof personalAccessTokenWire> {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt
  };
}

/** Loads a personal access token by id, revoked or not, or throws `OpError(404)`. */
export async function personalAccessToken(
  db: Db,
  id: string
): Promise<PersonalAccessTokenRow> {
  const row = await db
    .selectFrom('personalAccessTokens')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(
      HTTP_NOT_FOUND,
      `personal access token '${id}' not found`
    );
  }
  return row;
}

/** The `scope` of an operation addressing a token by `id`: one of the caller's own (§5.3). */
export async function ownPersonalAccessToken(
  ctx: Context,
  input: { id: string }
): Promise<boolean> {
  return (await personalAccessToken(ctx.db, input.id)).userId === ctx.actor.id;
}

/** The `ownerOnly` of an operation acting for `userId`: an owner's tokens are owner-only, like an
 *  owner's password (§10.3). Throws `OpError(404)` when no live user has that id. */
export function forAnOwner(
  ctx: Context,
  input: { userId: string }
): Promise<boolean> {
  return namesAnOwner(ctx, { id: input.userId });
}

/** The `ownerOnly` of an operation addressing a token by `id`: one of an owner's (§10.3). */
export async function anOwnersToken(
  ctx: Context,
  input: { id: string }
): Promise<boolean> {
  const token = await personalAccessToken(ctx.db, input.id);
  const user = await ctx.db
    .selectFrom('users')
    .select('role')
    .where('id', '=', token.userId)
    .executeTakeFirstOrThrow();
  return user.role === 'owner';
}
