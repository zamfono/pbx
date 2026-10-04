import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';
import { propagate } from '../propagate.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import { Conflict, defineOperation, type Context } from '../types.js';
import { liveTrunk } from './_shared.js';
import { emergencyTrunkWarnings } from './_writeChecks.js';

const inputSchema = z.object({ id: z.string().min(1) }).strict();
const outputSchema = idOutput.extend({ warnings: z.array(z.string()) });

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

export const deleteTrunk = defineOperation({
  name: 'trunks.delete',
  description:
    'Soft-deletes a SIP trunk once no outbound route or sip forward target uses it (409 names them).',
  input: inputSchema,
  output: outputSchema,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the trunk ${(await liveTrunk(ctx.db, input.id)).name}`
    ),
  entity: input => ({ kind: 'trunk', id: input.id }),
  run: async (ctx, input) => {
    await liveTrunk(ctx.db, input.id);
    const references = await trunkReferences(ctx, input.id);
    if (references.length > 0) {
      throw new Conflict(
        'trunk is used by outbound routes or sip forward targets',
        references
      );
    }
    await softDelete(ctx, 'trunks', input.id);
    propagate(ctx, ['pjsip']);
    return { id: input.id, warnings: await emergencyTrunkWarnings(ctx.db) };
  }
});
