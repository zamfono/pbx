import { z } from 'zod';

import { newId } from '@zamfono/shared';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation } from '../types.js';
import { E164_PATTERN } from './_shared.js';

const inputSchema = z
  .object({
    number: z
      .string()
      .regex(E164_PATTERN)
      .describe('The caller number to block, E.164 such as +4930123456.'),
    isPrefix: z
      .boolean()
      .optional()
      .describe(
        'Whether every caller whose number begins with `number` is blocked, not only that number; off by default.'
      ),
    label: z.string().nullable().optional()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

type CreateOutput = {
  id: string;
  number: string;
  isPrefix: boolean;
  label: string | null;
  createdAt: string;
};

/** `POST /blockedNumbers` (§10.1 "Entry", §10.3 "Blocklist"): a caller number or prefix to reject. */
export const create = defineOperation<Input, CreateOutput>({
  name: 'blockedNumbers.create',
  description:
    'Adds a number or number prefix to the tenant blocklist; a matching inbound caller is rejected with 603',
  input: inputSchema,
  minRole: 'admin',
  entity: (_input, output: CreateOutput) => ({
    kind: 'blockedNumber',
    id: output.id
  }),
  run: async (ctx, input) => {
    const isPrefix = input.isPrefix ?? false;
    const existing = await ctx.db
      .selectFrom('blockedNumbers')
      .select('id')
      .where('number', '=', input.number)
      .where('isPrefix', '=', isPrefix ? 1 : 0)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (existing) {
      throw new Conflict('blockedNumbers: already blocked', [
        { kind: 'blockedNumber', id: existing.id, label: input.number }
      ]);
    }
    const id = newId();
    const label = input.label ?? null;
    await ctx.db
      .insertInto('blockedNumbers')
      .values({
        id,
        number: input.number,
        isPrefix: isPrefix ? 1 : 0,
        label,
        createdBy: ctx.actor.id,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'number', from: null, to: input.number });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id, number: input.number, isPrefix, label, createdAt: ctx.now };
  }
});
