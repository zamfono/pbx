import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation, OpError, type Context } from '../types.js';
import {
  isOwnCall,
  toCallDetailOut,
  type CallDetailOut,
  type CallRow
} from './_shared.js';

/** The ended call `id`: a call still in progress is not history yet, so it answers 404 like an
 *  unknown id (§10.1 "Call aggregate"). */
async function endedCall(ctx: Context, id: string): Promise<CallRow> {
  const row = await ctx.db
    .selectFrom('calls')
    .selectAll()
    .where('id', '=', id)
    .where('endedAt', 'is not', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, `call '${id}' not found`);
  }
  return row;
}

/**
 * `GET /calls/{id}` (§7, §10.3 "Call history"): one call of the history with the diagnostics it
 * recorded — `calls.log` and its `call_qos` rows. A `user` reads only a call they are the caller,
 * the callee or the answering user of (§5.3).
 */
export const get = defineOperation<{ id: string }, CallDetailOut>({
  name: 'calls.get',
  description:
    'Reads one call of the history with its log and QoS summary: per leg jitter, loss, round trip and the packets received and sent.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  scope: async (ctx, input) =>
    isOwnCall(ctx.actor.id, await endedCall(ctx, input.id)),
  readOnly: true,
  run: async (ctx, input) =>
    toCallDetailOut(ctx.db, await endedCall(ctx, input.id))
});
