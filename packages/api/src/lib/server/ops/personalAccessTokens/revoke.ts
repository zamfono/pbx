import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange, setUndoable } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import {
  anOwnersToken,
  ownPersonalAccessToken,
  personalAccessToken,
  personalAccessTokenWire,
  toPersonalAccessTokenWire
} from './_shared.js';

/** `POST /personalAccessTokens/{id}/revoke` (§5.2, §10.3): the token stops working at once. */
export const revoke = defineOperation({
  name: 'personalAccessTokens.revoke',
  description:
    'Revokes a personal access token; the application using it loses access at once.',
  input: z.object({ id: z.string() }).strict(),
  output: personalAccessTokenWire,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'user',
  scope: ownPersonalAccessToken,
  ownerOnly: anOwnersToken,
  confirm: async (ctx, input) => {
    const token = await personalAccessToken(ctx.db, input.id);
    return `Revoke the personal access token '${token.name}'? The application using it loses access at once; this cannot be undone.`;
  },
  entity: input => ({ kind: 'personalAccessToken', id: input.id }),
  run: async (ctx, input) => {
    const token = await personalAccessToken(ctx.db, input.id);
    if (token.revokedAt !== null) {
      throw new OpError(HTTP_CONFLICT, 'personalAccessTokens: already revoked');
    }
    await ctx.db
      .updateTable('personalAccessTokens')
      .set({ revokedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'revokedAt', from: null, to: ctx.now });
    // A revoked credential is never revived (§5.8, §11.1 "Soft delete").
    setUndoable(ctx, false);
    return toPersonalAccessTokenWire({ ...token, revokedAt: ctx.now });
  }
});
