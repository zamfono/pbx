import { z } from 'zod';

import { recordChange } from '../audit.js';
import { createTarget } from '../forwardTargets.js';
import { targetSpecSchema } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { propagate } from '../propagate.js';
import { liveRow } from '../rows.js';
import { defineOperation } from '../types.js';
import { setCallerIdIfUnset } from './_callerId.js';

const inputSchema = z
  .object({
    id: z.string(),
    target: targetSpecSchema.describe(
      'Where a call to this number goes; a numeric DID for a user with no caller ID of their own becomes it.'
    )
  })
  .strict();

/**
 * `PATCH /dids/{id}` (§10.3 "Extensions & DIDs"): only the forward target is editable — `number`
 * is what the trunk boundary produced and `label` is set at creation.
 */
export const update = defineOperation({
  name: 'dids.update',
  description:
    "Changes a DID's forward target; number and label are fixed at creation",
  input: inputSchema,
  minRole: 'admin',
  entity: input => ({ kind: 'did', id: input.id }),
  run: async (ctx, input) => {
    const did = await liveRow(ctx.db, 'dids', input.id, 'dids: DID not found');
    const before = await resolveTarget(ctx.db, did.targetId);
    const targetId = await createTarget(ctx, input.target);
    await ctx.db
      .updateTable('dids')
      .set({ targetId })
      .where('id', '=', input.id)
      .execute();
    // The diff names this operation's own input field and carries the wire target, so `audit.undo`
    // replays it straight back through `dids.update` (§5.8, `revertDidUpdate`).
    recordChange(ctx, { field: 'target', from: before, to: input.target });
    if (input.target.kind === 'user') {
      await setCallerIdIfUnset(ctx, input.target.userId, did.id, did.number);
    }
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id: did.id,
      number: did.number,
      label: did.label,
      target: input.target,
      createdAt: did.createdAt
    };
  }
});
