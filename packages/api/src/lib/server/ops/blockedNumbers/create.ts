import { z } from 'zod';

import { HTTP_CONFLICT, isE164, newId } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { blockedNumberWire } from './_shared.js';

const inputSchema = z
  .object({
    number: z
      .string()
      .refine(isE164, 'number must be E.164')
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

/** `POST /blockedNumbers` (§10.1 "Entry", §10.3 "Blocklist"): a caller number or prefix to reject. */
export const create = defineOperation({
  name: 'blockedNumbers.create',
  description:
    'Adds a number or number prefix to the tenant blocklist; a matching inbound caller is rejected with 603',
  input: inputSchema,
  output: blockedNumberWire,
  problems: [HTTP_CONFLICT],
  minRole: 'admin',
  entity: (_input, output) => ({
    kind: 'blockedNumber',
    id: output.id
  }),
  run: async (ctx, input) => {
    const isPrefix = input.isPrefix ?? false;
    await assertNoLiveHolder(ctx.db, 'blockedNumbers: already blocked', {
      table: 'blockedNumbers',
      kind: 'blockedNumber',
      label: 'number',
      values: { number: input.number, isPrefix: isPrefix ? 1 : 0 }
    });
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
