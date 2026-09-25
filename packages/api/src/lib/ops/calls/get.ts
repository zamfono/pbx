import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { isOwnCall, toCallDetailOut, type CallDetailOut } from './_shared.js';

const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;

/**
 * `GET /calls/{id}` (§7, §10.3 "Call history"): one call of the history with the diagnostics it
 * recorded — `calls.log` and its `call_qos` rows. A `user` reads only a call they are the caller,
 * the callee or the answering user of (§5.3). A call still in progress is not history yet, so it
 * answers 404 like an unknown id (§10.1 "Call aggregate").
 */
export const get = defineOperation<{ id: string }, CallDetailOut>({
  name: 'calls.get',
  description: 'Reads one call of the history with its log and QoS summary.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('calls')
      .selectAll()
      .where('id', '=', input.id)
      .where('endedAt', 'is not', null)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, `call '${input.id}' not found`);
    }
    if (ctx.actor.role === 'user' && !isOwnCall(ctx.actor.id, row)) {
      throw new OpError(
        STATUS_FORBIDDEN,
        'calls: may read only your own calls'
      );
    }
    return toCallDetailOut(ctx.db, row);
  }
});
