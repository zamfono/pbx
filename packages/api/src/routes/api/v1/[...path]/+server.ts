import type { RequestEvent } from '@sveltejs/kit';

import { newId } from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';

// Side-effect import: fills the registry (§10.3) every area's own operations register into, so
// the route table below actually has something to dispatch to instead of 501ing on every call.
import '#lib/server/ops/index.js';

import { handleRest } from '#lib/server/rest.js';

/** Every REST verb funnels through the same catch-all handler (§10.3); the route table decides what each one does. */
function handle(event: RequestEvent): Promise<Response> {
  const { auth } = event.locals;
  return handleRest(event.request, auth?.actor ?? null, {
    db: getDb(),
    requestId: newId(),
    clientId: auth?.clientId,
    clientName: auth?.clientName
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
