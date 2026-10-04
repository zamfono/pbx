import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  newId
} from '@zamfono/shared';

import { newPersonalAccessToken } from '#lib/server/auth/personalAccessTokens.js';

import { recordChange, setUndoable } from '../audit.js';
import { ownActingUser } from '../gates.js';
import { isoDatetimeInput, toUtcIso } from '../ooo/_shared.js';
import { Conflict, defineOperation, OpError } from '../types.js';
import { liveUser } from '../users/_shared.js';
import {
  forAnOwner,
  personalAccessTokenWire,
  toPersonalAccessTokenWire
} from './_shared.js';

// A name says which application holds the token; this bounds it like `client_name` (§5.2).
const NAME_MAX_LENGTH = 100;

const inputSchema = z
  .object({
    userId: z.string(),
    name: z
      .string()
      .min(1)
      .max(NAME_MAX_LENGTH)
      .describe(
        'Which application holds the token, unique among the user’s live tokens, e.g. crm-sync.'
      ),
    expiresAt: isoDatetimeInput
      .nullable()
      .optional()
      .describe(
        'When the token stops working, ISO 8601 with an offset, in the future; null or left out: never.'
      )
  })
  .strict();

const outputSchema = personalAccessTokenWire.extend({
  token: z
    .string()
    .describe(
      'The bearer token, zpat_…, shown this once: only its hash is stored.'
    )
});

/** `POST /users/{id}/personalAccessTokens` (§5.2, §10.3): a bearer token for a server application, returned once. */
export const create = defineOperation({
  name: 'personalAccessTokens.create',
  description:
    'Creates a personal access token, acting as the user, for a server application; its value is returned once.',
  input: inputSchema,
  output: outputSchema,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'user',
  scope: ownActingUser,
  ownerOnly: forAnOwner,
  entity: (_input, output) => ({ kind: 'personalAccessToken', id: output.id }),
  run: async (ctx, input) => {
    await liveUser(ctx.db, input.userId);
    const expiresAt =
      input.expiresAt === undefined || input.expiresAt === null
        ? null
        : toUtcIso(input.expiresAt);
    if (expiresAt !== null && expiresAt <= ctx.now) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'personalAccessTokens: expiresAt must lie in the future'
      );
    }
    // An expired token is not live, so its name is free (§5.2); the index keeps names unique among
    // the unrevoked (§11.2), so the expired token of this name is revoked first.
    await ctx.db
      .updateTable('personalAccessTokens')
      .set({ revokedAt: ctx.now })
      .where('userId', '=', input.userId)
      .where('name', '=', input.name)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '<=', ctx.now)
      .execute();
    const taken = await ctx.db
      .selectFrom('personalAccessTokens')
      .select('id')
      .where('userId', '=', input.userId)
      .where('name', '=', input.name)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    if (taken) {
      throw new Conflict('personalAccessTokens: name taken', [
        { kind: 'personalAccessToken', id: taken.id, label: input.name }
      ]);
    }
    const { raw, tokenHash } = newPersonalAccessToken();
    const row = {
      id: newId(),
      tokenHash,
      userId: input.userId,
      name: input.name,
      createdBy: ctx.actor.id,
      createdAt: ctx.now,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null
    };
    await ctx.db.insertInto('personalAccessTokens').values(row).execute();
    recordChange(ctx, { field: 'userId', from: null, to: input.userId });
    recordChange(ctx, { field: 'name', from: null, to: input.name });
    recordChange(ctx, { field: 'expiresAt', from: null, to: expiresAt });
    // A credential is revoked, never undone (§5.8, §11.1 "Soft delete").
    setUndoable(ctx, false);
    return { ...toPersonalAccessTokenWire(row), token: raw };
  }
});
