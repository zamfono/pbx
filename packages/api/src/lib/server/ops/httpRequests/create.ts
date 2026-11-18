import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND, newId } from '@zamfono/shared';

import { recordChange, setUndoable } from '../audit.js';
import { writeForwardTarget } from '../forwardTargetWrite.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import {
  assertNameAvailable,
  DEFAULT_TIMEOUT_S,
  httpRequestFieldsOfNode,
  httpRequestOut,
  liveHttpRequest,
  requestColumns,
  toHttpRequestOut,
  type HttpRequestOut
} from './_shared.js';

const inputSchema = z
  .object({
    ...httpRequestFieldsOfNode,
    timeoutS: httpRequestFieldsOfNode.timeoutS.default(DEFAULT_TIMEOUT_S)
  })
  .strict();

/** `POST /httpRequests` (§10.1 step 7 "HTTP requests", §10.3). */
export const createHttpRequest = defineOperation({
  name: 'httpRequests.create',
  description:
    'Creates an HTTP request for call flows: sent while a call waits, its JSON answer readable in templates under its name, with a target for the call after it and one for a failed request.',
  input: inputSchema,
  output: httpRequestOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: (_input, out: HttpRequestOut) => ({
    kind: 'httpRequest',
    id: out.id
  }),
  run: async (ctx, input) => {
    await assertNameAvailable(ctx.db, input.name);
    const id = newId();
    const columns = await requestColumns(ctx.db, input.request);
    const targetId = await writeForwardTarget(ctx, input.target, null);
    const errorTargetId = await writeForwardTarget(
      ctx,
      input.errorTarget,
      null
    );
    await ctx.db
      .insertInto('httpRequests')
      .values({
        id,
        name: input.name,
        ...columns,
        timeoutS: input.timeoutS,
        targetId,
        errorTargetId,
        createdAt: ctx.now
      })
      .execute();
    recordChange(ctx, { field: 'name', from: null, to: input.name });
    if (columns.secretEnc !== null || columns.secretHeadersEnc !== null) {
      // A credential was written, so there is no earlier state to restore (§5.8).
      setUndoable(ctx, false);
    }
    // Read by the routing pipeline (§3.1).
    propagate(ctx, []);
    return toHttpRequestOut(ctx.db, await liveHttpRequest(ctx.db, id));
  }
});
