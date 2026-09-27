import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError } from '../types.js';
import { loadTrunkRow, STATUS_NOT_FOUND } from './_shared.js';
import { emergencyTrunkWarnings } from './_writeChecks.js';

const inputSchema = z.object({ id: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
type Output = { id: string; warnings: string[] };

export const deleteTrunk = defineOperation<Input, Output>({
  name: 'trunks.delete',
  description: 'Soft-deletes a SIP trunk.',
  input: inputSchema,
  minRole: 'admin',
  confirm: () => 'Delete this trunk? The deletion can be undone for 30 days.',
  entity: input => ({ kind: 'trunk', id: input.id }),
  run: async (ctx, input) => {
    const row = await loadTrunkRow(ctx.db, input.id);
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, 'trunk not found');
    }
    const routes = await ctx.db
      .selectFrom('outboundRoutes')
      .select(['id', 'priority'])
      .where('trunkId', '=', input.id)
      .where('deletedAt', 'is', null)
      .execute();
    if (routes.length > 0) {
      throw new Conflict(
        'trunk is used by outbound routes',
        routes.map(route => ({
          kind: 'outboundRoute',
          id: route.id,
          label: `outbound route (priority ${route.priority})`
        }))
      );
    }
    await ctx.db
      .updateTable('trunks')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    propagate(ctx, ['pjsip']);
    return { id: input.id, warnings: await emergencyTrunkWarnings(ctx.db) };
  }
});
