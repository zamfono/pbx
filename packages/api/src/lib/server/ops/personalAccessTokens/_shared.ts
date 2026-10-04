import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  type DB,
  type Db
} from '@zamfono/shared';

import { OpError, type Context } from '../types.js';

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

/** Throws 403 unless the caller may act on the tokens of a user holding `role`: an owner's are
 *  owner-only, like an owner's password (§10.3). */
export function assertMayActFor(ctx: Context, role: string): void {
  if (role === 'owner' && ctx.actor.role !== 'owner') {
    throw new OpError(
      HTTP_FORBIDDEN,
      "personalAccessTokens: only owners act on an owner's tokens"
    );
  }
}
