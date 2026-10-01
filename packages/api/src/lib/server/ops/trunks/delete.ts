import { z } from 'zod';

import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';
import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError, type Context } from '../types.js';
import { loadTrunkRow, STATUS_NOT_FOUND } from './_shared.js';
import { emergencyTrunkWarnings } from './_writeChecks.js';

const inputSchema = z.object({ id: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
type Output = { id: string; warnings: string[] };

/**
 * What still dials over trunk `id` (§5.9): its live outbound routes, and the owners of the `sip`
 * targets that name it, the rules, numbers and fallbacks `findForwardTargetOwners` reports live.
 */
async function trunkReferences(ctx: Context, id: string): Promise<Reference[]> {
  const [routes, sipTargets] = await Promise.all([
    ctx.db
      .selectFrom('outboundRoutes')
      .select(['id', 'priority'])
      .where('trunkId', '=', id)
      .where('deletedAt', 'is', null)
      .execute(),
    ctx.db
      .selectFrom('forwardTargets')
      .select('id')
      .where('sipTrunkId', '=', id)
      .execute()
  ]);
  const owners = await findForwardTargetOwners(
    ctx.db,
    sipTargets.map(row => row.id)
  );
  return [
    ...routes.map(route => ({
      kind: 'outboundRoute',
      id: route.id,
      label: `outbound route (priority ${route.priority})`
    })),
    ...owners
  ];
}

export const deleteTrunk = defineOperation<Input, Output>({
  name: 'trunks.delete',
  description:
    'Soft-deletes a SIP trunk once no outbound route or sip forward target uses it (409 names them).',
  input: inputSchema,
  minRole: 'admin',
  confirm: () => 'Delete this trunk? The deletion can be undone for 30 days.',
  entity: input => ({ kind: 'trunk', id: input.id }),
  run: async (ctx, input) => {
    const row = await loadTrunkRow(ctx.db, input.id);
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, 'trunk not found');
    }
    const references = await trunkReferences(ctx, input.id);
    if (references.length > 0) {
      throw new Conflict(
        'trunk is used by outbound routes or sip forward targets',
        references
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
