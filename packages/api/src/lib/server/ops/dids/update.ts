import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange, recordFieldChanges } from '../audit.js';
import { createTarget } from '../forwardTargets.js';
import { targetSpecSchema } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import { orBefore } from '../patch.js';
import { propagate } from '../propagate.js';
import { liveRow } from '../rows.js';
import { defineOperation } from '../types.js';
import { setCallerIdIfUnset } from './_callerId.js';
import { didOut } from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable().optional(),
    target: targetSpecSchema
      .describe(
        'Where a call to this number goes; a numeric DID for a user with no caller ID of their own becomes it.'
      )
      .optional()
  })
  .strict();

/**
 * `PATCH /dids/{id}` (§10.3 "Extensions & DIDs"): label and forward target are editable; `number`
 * is immutable, since an inbound call is matched by it.
 */
export const update = defineOperation({
  name: 'dids.update',
  description:
    "Changes a DID's label or forward target; the number is immutable",
  input: inputSchema,
  output: didOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  entity: input => ({ kind: 'did', id: input.id }),
  run: async (ctx, input) => {
    const did = await liveRow(ctx.db, 'dids', input.id, 'dids: DID not found');
    const before = await resolveTarget(ctx.db, did.targetId);
    const label = orBefore(input.label, did.label);
    const targetId =
      input.target === undefined
        ? did.targetId
        : await createTarget(ctx, input.target);
    await ctx.db
      .updateTable('dids')
      .set({ label, targetId })
      .where('id', '=', input.id)
      .execute();
    recordFieldChanges(ctx, did, { label });
    if (input.target !== undefined) {
      // The diff names this operation's own input field and carries the wire target, so
      // `audit.undo` replays it straight back through `dids.update` (§5.8, `revertDidUpdate`).
      recordChange(ctx, { field: 'target', from: before, to: input.target });
      if (input.target.kind === 'user') {
        await setCallerIdIfUnset(ctx, input.target.userId, did.id, did.number);
      }
    }
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id: did.id,
      number: did.number,
      label,
      target: input.target ?? before,
      createdAt: did.createdAt
    };
  }
});
