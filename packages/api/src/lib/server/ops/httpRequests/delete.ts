import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { idOutput, softDelete, softDeleteQuestion } from '../rows.js';
import { Conflict, defineOperation } from '../types.js';
import { findHttpRequestReferences, liveHttpRequest } from './_shared.js';

/** `DELETE /httpRequests/{id}` (§5.9): refused while a target outside the request names it; its
 * two targets travel with it. A template that reads its name renders that empty from then on. */
export const deleteHttpRequest = defineOperation({
  name: 'httpRequests.delete',
  description: 'Soft-deletes an HTTP request of call flows.',
  input: z.object({ id: z.string() }).strict(),
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  confirm: async (ctx, input) =>
    softDeleteQuestion(
      ctx,
      `the HTTP request ${(await liveHttpRequest(ctx.db, input.id)).name}`
    ),
  entity: input => ({ kind: 'httpRequest', id: input.id }),
  run: async (ctx, input) => {
    await liveHttpRequest(ctx.db, input.id);
    const references = await findHttpRequestReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('HTTP request is still in use', references);
    }
    await softDelete(ctx, 'httpRequests', input.id);
    // Read by the routing pipeline (§3.1).
    propagate(ctx, []);
    return { id: input.id };
  }
});
