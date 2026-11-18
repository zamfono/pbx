import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange, recordFieldChanges, setUndoable } from '../audit.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import type { TargetSpec } from '../forwardTargetType.js';
import { writeForwardTarget } from '../forwardTargetWrite.js';
import { propagate } from '../propagate.js';
import { defineOperation, type Context } from '../types.js';
import {
  assertNameAvailable,
  httpRequestFieldsOfNode,
  httpRequestOut,
  liveHttpRequest,
  requestColumns,
  requestWire,
  toHttpRequestOut,
  type HttpRequestRow,
  type RequestInput
} from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    ...z.object(httpRequestFieldsOfNode).partial().shape
  })
  .strict();

/** Writes `target`, where given, into the forward target row `id` the request holds as `field`
 * (§11.2), recorded as that field. */
async function writeTargetField(
  ctx: Context,
  field: 'target' | 'errorTarget',
  id: string,
  target: TargetSpec | undefined
): Promise<void> {
  if (target === undefined) {
    return;
  }
  recordChange(ctx, {
    field,
    from: await resolveTarget(ctx.db, id),
    to: target
  });
  await writeForwardTarget(ctx, target, id);
}

/** The request's columns after the write, recorded as `request` in the shape a read returns;
 * a change that touches a secret cannot be undone (§5.8). */
async function replaceRequest(
  ctx: Context,
  before: HttpRequestRow,
  request: RequestInput | undefined
): Promise<Partial<HttpRequestRow>> {
  if (request === undefined) {
    return {};
  }
  const columns = await requestColumns(ctx.db, request, before);
  const after = requestWire({ ...before, ...columns });
  recordChange(ctx, {
    field: 'request',
    from: requestWire(before),
    to: after
  });
  if (
    request.secret !== undefined ||
    before.secretHeadersEnc !== null ||
    columns.secretHeadersEnc !== null
  ) {
    setUndoable(ctx, false);
  }
  return columns;
}

/** `PATCH /httpRequests/{id}` (§10.3): each field given replaces the request's, `request` as a
 * whole. Every field is recorded in this operation's own input shape, so `audit.undo` replays
 * `from` through it (§5.8). */
export const updateHttpRequest = defineOperation({
  name: 'httpRequests.update',
  description:
    "Updates an HTTP request's name, request, timeout, target or error target, the request replaced as a whole.",
  input: inputSchema,
  output: httpRequestOut,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  entity: input => ({ kind: 'httpRequest', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveHttpRequest(ctx.db, input.id);
    const name = input.name ?? before.name;
    if (name !== before.name) {
      await assertNameAvailable(ctx.db, name, input.id);
    }
    const timeoutS = input.timeoutS ?? before.timeoutS;
    recordFieldChanges(ctx, before, { name, timeoutS });
    const columns = await replaceRequest(ctx, before, input.request);
    await writeTargetField(ctx, 'target', before.targetId, input.target);
    await writeTargetField(
      ctx,
      'errorTarget',
      before.errorTargetId,
      input.errorTarget
    );
    await ctx.db
      .updateTable('httpRequests')
      .set({ name, timeoutS, ...columns })
      .where('id', '=', input.id)
      .execute();
    // Read by the routing pipeline (§3.1).
    propagate(ctx, []);
    return toHttpRequestOut(ctx.db, await liveHttpRequest(ctx.db, input.id));
  }
});
