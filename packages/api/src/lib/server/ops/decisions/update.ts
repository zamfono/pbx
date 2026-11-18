import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import {
  deleteForwardTargets,
  insertForwardTarget,
  resolveTarget
} from '../forwardTargetSpec.js';
import { changeOwnedExtension, ownedExtension } from '../ownedExtension.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { defineOperation } from '../types.js';
import {
  assertNameAvailable,
  decisionCases,
  decisionFields,
  decisionOut,
  deleteCases,
  insertCases,
  liveDecision,
  toDecisionOut
} from './_shared.js';

export const updateDecisionInput = z
  .object({ id: z.string(), ...z.object(decisionFields).partial().shape })
  .strict();

/** `PATCH /decisions/{id}` (§10.3): each field given replaces the decision's, `cases` as a whole.
 * Every field is recorded in this operation's own input shape, so `audit.undo` replays `from`
 * through it (§5.8). */
export const updateDecision = defineOperation({
  name: 'decisions.update',
  description:
    "Updates a decision's name, extension, default target or cases, the cases replaced as a whole.",
  input: updateDecisionInput,
  output: decisionOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: input => ({ kind: 'decision', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveDecision(ctx.db, input.id);
    const name = input.name ?? before.name;
    if (name !== before.name) {
      await assertNameAvailable(ctx.db, name, input.id);
      recordChange(ctx, { field: 'name', from: before.name, to: name });
    }
    let { defaultTargetId } = before;
    if (input.default !== undefined) {
      recordChange(ctx, {
        field: 'default',
        from: await resolveTarget(ctx.db, before.defaultTargetId),
        to: input.default
      });
      defaultTargetId = await insertForwardTarget(ctx, input.default);
    }
    await ctx.db
      .updateTable('decisions')
      .set({ name, defaultTargetId })
      .where('id', '=', input.id)
      .execute();
    if (defaultTargetId !== before.defaultTargetId) {
      await deleteForwardTargets(ctx.db, [before.defaultTargetId]);
    }
    if (input.cases !== undefined) {
      const previous = await decisionCases(ctx.db, input.id);
      await deleteCases(ctx.db, input.id);
      await insertCases(ctx, input.id, input.cases);
      recordChange(ctx, { field: 'cases', from: previous, to: input.cases });
    }
    const extensionChanged = await changeOwnedExtension(
      ctx,
      { decisionId: input.id },
      input.extension
    );
    // Read by the routing pipeline (§3.1).
    propagate(ctx, []);
    // The roster lists the extension, titled by the decision's name (§10.4 "Colleague presence").
    if (
      extensionChanged ||
      (name !== before.name &&
        (await ownedExtension(ctx.db, { decisionId: input.id })) !== null)
    ) {
      await pushRoster(ctx);
    }
    return toDecisionOut(ctx.db, await liveDecision(ctx.db, input.id));
  }
});
