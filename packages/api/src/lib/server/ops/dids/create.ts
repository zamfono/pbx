import { z } from 'zod';

import { isE164, newId, normalizeInbound } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { createTarget } from '../forwardTargets.js';
import { targetSpecSchema, type TargetSpec } from '../forwardTargetSchema.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { propagate } from '../propagate.js';
import { defineOperation, type Context } from '../types.js';

const inputSchema = z
  .object({
    number: z
      .string()
      .min(1)
      .regex(/^\S+$/u, 'number: no whitespace')
      .describe(
        "The called number: E.164 such as +4989123456, or national such as 089123456, normalized with settings.country; anything else, such as a provider's account name, is matched verbatim."
      ),
    label: z.string().nullable().optional(),
    target: targetSpecSchema.describe(
      'Where a call to this number goes; a numeric DID for a user with no caller ID of their own becomes it.'
    )
  })
  .strict();

type CreateOutput = {
  id: string;
  number: string;
  label: string | null;
  target: TargetSpec;
  createdAt: string;
};

/**
 * Sets a user's caller-ID DID the first time they receive one (§9.4 "Caller-ID"): a user target
 * that so far presents no number of their own gets this DID as `users.callerid_did_id`.
 */
async function setCallerIdIfUnset(
  ctx: Context,
  userId: string,
  didId: string,
  number: string
): Promise<void> {
  const user = await ctx.db
    .selectFrom('users')
    .select('calleridDidId')
    .where('id', '=', userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (user?.calleridDidId === null && isE164(number)) {
    await ctx.db
      .updateTable('users')
      .set({ calleridDidId: didId })
      .where('id', '=', userId)
      .execute();
    recordChange(ctx, { field: 'callerIdDidId', from: null, to: didId });
  }
}

/** `POST /dids` (§10.3 "Extensions & DIDs", §11.3): a DID and the forward target it dials to. */
export const create = defineOperation({
  name: 'dids.create',
  description:
    'Adds a DID, a phone number the tenant owns, and the forward target its calls go to (zamfono.help numbers)',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, output: CreateOutput) => ({ kind: 'did', id: output.id }),
  run: async (ctx, input) => {
    const settings = await ctx.db
      .selectFrom('settings')
      .select('country')
      .executeTakeFirstOrThrow();
    const number = normalizeInbound(input.number, 'national', settings.country);
    await assertNoLiveHolder(ctx.db, 'dids: number already in use', {
      table: 'dids',
      kind: 'did',
      label: 'number',
      values: { number }
    });
    const targetId = await createTarget(ctx, input.target);
    const id = newId();
    const label = input.label ?? null;
    await ctx.db
      .insertInto('dids')
      .values({ id, number, label, targetId, createdAt: ctx.now })
      .execute();
    if (input.target.kind === 'user') {
      await setCallerIdIfUnset(ctx, input.target.userId, id, number);
    }
    const output: CreateOutput = {
      id,
      number,
      label,
      target: input.target,
      createdAt: ctx.now
    };
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return output;
  }
});
