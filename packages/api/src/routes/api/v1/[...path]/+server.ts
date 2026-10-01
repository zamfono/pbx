import type { RequestEvent } from '@sveltejs/kit';

import { newId, type Db } from '@zamfono/shared';

import { getDb } from '$lib/server/db.js';

// Side-effect import: fills the registry (§10.3) every area's own operations register into, so
// the route table below actually has something to dispatch to instead of 501ing on every call.
import '$lib/server/ops/index.js';

import { handleRest } from '$lib/server/rest.js';

/** The `oauth_clients` name behind `clientId`, for `audit_log.client_name` (§5.7). */
async function clientNameFor(
  db: Db,
  clientId: string | null
): Promise<string | undefined> {
  if (clientId === null) {
    return undefined;
  }
  const row = await db
    .selectFrom('oauthClients')
    .select('name')
    .where('clientId', '=', clientId)
    .executeTakeFirst();
  return row?.name;
}

/** Every REST verb funnels through the same catch-all handler (§10.3); the route table decides what each one does. */
async function handle(event: RequestEvent): Promise<Response> {
  const db = getDb();
  const clientId = event.locals.clientId;
  return handleRest(event.request, event.locals.actor, {
    db,
    requestId: newId(),
    clientId,
    clientName: await clientNameFor(db, clientId)
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
