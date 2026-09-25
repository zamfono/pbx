import { z } from 'zod';

import { newId, normalizeInbound } from '@zamfono/shared';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, type Context } from '../types.js';
import {
  createTarget,
  targetInputSchema,
  type TargetInput
} from './_shared.js';

/** The `+` and digits shape of a numeric DID (§9.4 "Caller-ID"): only such a DID may be presented. */
const NUMERIC_NUMBER = /^\+[0-9]+$/u;

const inputSchema = z
  .object({
    number: z.string().min(1).regex(/^\S+$/u, 'number: no whitespace'),
    label: z.string().nullable().optional(),
    target: targetInputSchema
  })
  .strict();

type CreateOutput = {
  id: string;
  number: string;
  label: string | null;
  target: TargetInput;
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
  if (user?.calleridDidId === null && NUMERIC_NUMBER.test(number)) {
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
  description: 'Adds a DID and its forward target',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, output: CreateOutput) => ({ kind: 'did', id: output.id }),
  run: async (ctx, input) => {
    const settings = await ctx.db
      .selectFrom('settings')
      .select('country')
      .executeTakeFirstOrThrow();
    const number = normalizeInbound(input.number, 'national', settings.country);
    const existing = await ctx.db
      .selectFrom('dids')
      .select('id')
      .where('number', '=', number)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (existing) {
      throw new Conflict('dids: number already in use', [
        { kind: 'did', id: existing.id, label: number }
      ]);
    }
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
