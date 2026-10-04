import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { renumberPriorities } from '../rows.js';
import { defineOperation, OpError } from '../types.js';

const inputSchema = z
  .object({
    trunkIds: z
      .array(z.string().min(1))
      .describe('Every live trunk id exactly once, in the new order.')
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type Output = { trunkIds: string[] };

export const setOrder = defineOperation<Input, Output>({
  name: 'trunks.setOrder',
  description:
    'Rewrites the tenant trunk order, the order emergency calls try emergency trunks in (§9.4 "Trunk order").',
  input: inputSchema,
  minRole: 'admin',
  entity: () => ({ kind: 'trunk', id: null }),
  run: async (ctx, input) => {
    const live = await ctx.db
      .selectFrom('trunks')
      .select('id')
      .where('deletedAt', 'is', null)
      .orderBy('priority')
      .execute();
    const liveIds = new Set(live.map(trunk => trunk.id));
    const inputIds = new Set(input.trunkIds);
    const sameSize =
      liveIds.size === inputIds.size && liveIds.size === input.trunkIds.length;
    const everyLiveTrunkNamed =
      sameSize && live.every(trunk => inputIds.has(trunk.id));
    if (!everyLiveTrunkNamed) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'trunkIds must name every live trunk exactly once'
      );
    }
    const previousOrder = live.map(trunk => trunk.id);
    await renumberPriorities(
      ctx.db,
      'trunks',
      input.trunkIds.map((id, index) => ({ id, priority: index + 1 }))
    );
    recordChange(ctx, {
      field: 'trunkIds',
      from: previousOrder,
      to: input.trunkIds
    });
    propagate(ctx, ['pjsip']);
    return { trunkIds: input.trunkIds };
  }
});
