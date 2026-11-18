import type { Db } from '@zamfono/shared';

import type { Reference } from './forwardTargetOwners.js';

/**
 * The live HTTP requests whose `target_id` or `error_target_id` is one of `ftIds`, outside
 * `httpRequestId`'s own scope: a request's own two targets travel with it (§5.9) rather than
 * blocking its own delete.
 */
export async function httpRequestOwners(
  db: Db,
  ftIds: string[],
  httpRequestId: string | undefined
): Promise<Reference[]> {
  let query = db
    .selectFrom('httpRequests')
    .select(['id', 'name', 'targetId'])
    .where(eb =>
      eb.or([eb('targetId', 'in', ftIds), eb('errorTargetId', 'in', ftIds)])
    )
    .where('deletedAt', 'is', null);
  if (httpRequestId !== undefined) {
    query = query.where('id', '!=', httpRequestId);
  }
  return (await query.execute()).map(row => ({
    kind: 'httpRequest',
    id: row.id,
    label: `${row.name} (${ftIds.includes(row.targetId) ? 'target' : 'error target'})`
  }));
}
