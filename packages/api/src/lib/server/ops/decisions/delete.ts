import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { dropOwnedExtension } from '../ownedExtension.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import { Conflict, defineOperation } from '../types.js';
import { findDecisionReferences } from './_references.js';
import { liveDecision } from './_shared.js';

/** `DELETE /decisions/{id}` (§5.9): refused while a target outside the decision names it; its
 * extension is freed, its cases and conditions travel with it. */
export const deleteDecision = defineOperation({
  name: 'decisions.delete',
  description: 'Soft-deletes a decision.',
  input: z.object({ id: z.string() }).strict(),
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the decision ${(await liveDecision(ctx.db, input.id)).name}`
    ),
  entity: input => ({ kind: 'decision', id: input.id }),
  run: async (ctx, input) => {
    await liveDecision(ctx.db, input.id);
    const references = await findDecisionReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('decision is still in use', references);
    }
    await softDelete(ctx, 'decisions', input.id);
    const ext = await dropOwnedExtension(ctx, { decisionId: input.id });
    // Read by the routing pipeline (§3.1).
    propagate(ctx, []);
    if (ext !== null) {
      await pushRoster(ctx);
    }
    return { id: input.id };
  }
});
