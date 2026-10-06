import * as env from '$app/env/private';
import { z } from 'zod';

import {
  HTTP_NOT_FOUND,
  resetMfa as removeMfaAndSessions
} from '@zamfono/shared';

import { noticeMfaChange } from '#lib/server/auth/mfa/notice.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { afterCommit } from '../afterCommit.js';
import { recordChange, setUndoable } from '../audit.js';
import { idOutput } from '../rows.js';
import { defineOperation } from '../types.js';
import { liveUser, namesAnOwner } from './_shared.js';

/** `POST /users/{id}/resetMfa` (§5.2 "Two-factor authentication", §10.3): removes every second
 *  factor and recovery code of a user and ends their sessions; one who must have a second factor
 *  sets one up at their next sign-in. An owner's is owner-only, like `users.resetPassword`. */
export const resetMfa = defineOperation({
  name: 'users.resetMfa',
  description:
    "Removes a user's two-factor methods and recovery codes and signs them out everywhere.",
  input: z.object({ id: z.string() }).strict(),
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  ownerOnly: namesAnOwner,
  confirm: async (ctx, input) => {
    const user = await liveUser(ctx.db, input.id);
    return `Reset the two-factor sign-in of ${user.name}? Their methods and recovery codes are removed and every session of theirs ends; this cannot be undone.`;
  },
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    await liveUser(ctx.db, input.id);
    const before = await removeMfaAndSessions(ctx.db, input.id, ctx.now);
    recordChange(ctx, { field: 'mfa', from: before, to: null });
    recordChange(ctx, { field: 'tokensRevoked', from: false, to: true });
    // A removed secret is never restored (§5.8): the user enrols again.
    setUndoable(ctx, false);
    afterCommit(ctx, db => {
      noticeMfaChange(db, keyringFromEnv(env), input.id, { kind: 'reset' });
      return Promise.resolve(null);
    });
    return { id: input.id };
  }
});
