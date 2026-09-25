import { z } from 'zod';

import type { Db } from '@zamfono/shared';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { STATUS_UNPROCESSABLE_ENTITY } from './_shared.js';

const inputSchema = z.object({ trunkIds: z.array(z.string().min(1)) }).strict();
type Input = z.infer<typeof inputSchema>;
type Output = { trunkIds: string[] };

/**
 * Past any priority a live trunk count in the MVP's range could reach; large enough that a
 * temporary value never collides with another row's still-current priority.
 */
const TEMP_PRIORITY_OFFSET = 1_000_000;

/**
 * Rewrites `trunks.priority` to `orderedIds`' order via a temporary-priority pass first: the
 * `priority` column is unique among live trunks and `CHECK (priority >= 1)`, so moving every row
 * through a temporary, mutually distinct value past that offset avoids colliding with another
 * row's still-current priority before every row reaches its final, positive one — `orderedIds`
 * names every live trunk exactly once (its caller checked this), so no live trunk outside it can
 * hold a temporary value either (§9.4 "Trunk order").
 */
async function reorderTrunks(db: Db, orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, index) =>
      db
        .updateTable('trunks')
        .set({ priority: TEMP_PRIORITY_OFFSET + index + 1 })
        .where('id', '=', id)
        .execute()
    )
  );
  await Promise.all(
    orderedIds.map((id, index) =>
      db
        .updateTable('trunks')
        .set({ priority: index + 1 })
        .where('id', '=', id)
        .execute()
    )
  );
}

export const setOrder = defineOperation<Input, Output>({
  name: 'trunks.setOrder',
  description: 'Rewrites the tenant trunk order (§9.4 "Trunk order").',
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
        STATUS_UNPROCESSABLE_ENTITY,
        'trunkIds must name every live trunk exactly once'
      );
    }
    const previousOrder = live.map(trunk => trunk.id);
    await reorderTrunks(ctx.db, input.trunkIds);
    recordChange(ctx, {
      field: 'trunkIds',
      from: previousOrder,
      to: input.trunkIds
    });
    propagate(ctx, ['pjsip']);
    return { trunkIds: input.trunkIds };
  }
});
