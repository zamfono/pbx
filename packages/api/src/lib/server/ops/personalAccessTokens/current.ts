import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation, OpError } from '../types.js';
import {
  personalAccessToken,
  personalAccessTokenWire,
  toPersonalAccessTokenWire
} from './_shared.js';

/** `GET /personalAccessTokens/current` (§5.2, §10.3): the token the caller presented. */
export const current = defineOperation({
  name: 'personalAccessTokens.current',
  description:
    'Reads the personal access token the caller authenticated with, e.g. to see when it expires; 404 for a caller without one.',
  input: z.object({}).strict(),
  output: personalAccessTokenWire,
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async ctx => {
    const id = ctx.actor.personalAccessTokenId;
    if (id === undefined) {
      throw new OpError(
        HTTP_NOT_FOUND,
        'the caller did not authenticate with a personal access token'
      );
    }
    return toPersonalAccessTokenWire(await personalAccessToken(ctx.db, id));
  }
});
