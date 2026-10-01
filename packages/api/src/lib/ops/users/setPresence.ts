import { z } from 'zod';

import { propagate } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { liveUser } from './_shared.js';

const STATUS_FORBIDDEN = 403;

/**
 * `PUT /users/{id}/presence` (§10.2 "Presence", §5.7): sets DND, outside the audit log. The
 * propagation's `/internal/configChanged` makes `core` recompute presence from the new row, as
 * `*90`/`*91` do: the `presence` event, the `presence_log` row and the `Stasis:presence-<ext>`
 * hint (§9.3 "BLF and presence", §10.6).
 */
export const setPresence = defineOperation({
  name: 'users.setPresence',
  description: "Sets a user's do-not-disturb state.",
  input: z
    .object({
      id: z.string(),
      dnd: z
        .boolean()
        .describe(
          "Do not disturb: while on, calls follow the user's dnd forward rule, else their mailbox, else busy."
        )
    })
    .strict(),
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    if (ctx.actor.role === 'user' && ctx.actor.id !== input.id) {
      throw new OpError(
        STATUS_FORBIDDEN,
        'users: may set only your own presence'
      );
    }
    await liveUser(ctx.db, input.id);
    await ctx.db
      .updateTable('users')
      .set({ dnd: Number(input.dnd) })
      .where('id', '=', input.id)
      .execute();
    // Nothing Asterisk holds changes, but `core` must drop its cache: routing skips a member on
    // DND (§10.1 step 5), and presence is recomputed from it.
    propagate(ctx, []);
    return { id: input.id, dnd: input.dnd };
  }
});
