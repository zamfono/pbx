import { HTTP_UNPROCESSABLE_CONTENT, isE164, type Db } from '@zamfono/shared';

import { OpError } from '../types.js';

/** The subset of a route input that `replace`'s pre-write assertions need. */
export type RouteAssertInput = {
  id?: string;
  trunkId: string;
  calleridDidId?: string | null;
  users: string[];
  userGroups: string[];
};

/** Throws 422 naming every `trunkId` in `routes` that is not a live trunk. */
export async function assertTrunksLive(
  db: Db,
  routes: RouteAssertInput[]
): Promise<void> {
  const ids = [...new Set(routes.map(route => route.trunkId))];
  if (ids.length === 0) {
    return;
  }
  const rows = await db
    .selectFrom('trunks')
    .select('id')
    .where('id', 'in', ids)
    .where('deletedAt', 'is', null)
    .execute();
  const found = new Set(rows.map(row => row.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length > 0) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `unknown or deleted trunk: ${missing.join(', ')}`
    );
  }
}

/** Throws 422 for a `calleridDidId` that is not a live, numeric DID (§9.4 "Caller-ID"). */
export async function assertCallerIdsNumeric(
  db: Db,
  routes: RouteAssertInput[]
): Promise<void> {
  const ids = [
    ...new Set(
      routes
        .map(route => route.calleridDidId)
        .filter((id): id is string => id !== undefined && id !== null)
    )
  ];
  if (ids.length === 0) {
    return;
  }
  const rows = await db
    .selectFrom('dids')
    .select(['id', 'number'])
    .where('id', 'in', ids)
    .where('deletedAt', 'is', null)
    .execute();
  const numberById = new Map(rows.map(row => [row.id, row.number]));
  for (const id of ids) {
    const number = numberById.get(id);
    if (number === undefined) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `unknown or deleted DID: ${id}`
      );
    }
    if (!isE164(number)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `calleridDidId must be a numeric DID: ${id}`
      );
    }
  }
}

/**
 * Throws 422 naming every `users`/`userGroups` id in `routes` with no row at all. A soft-deleted
 * caller is accepted — it matches nobody at runtime (§5.9) rather than blocking the write.
 */
export async function assertCallersExist(
  db: Db,
  routes: RouteAssertInput[]
): Promise<void> {
  const userIds = [...new Set(routes.flatMap(route => route.users))];
  const groupIds = [...new Set(routes.flatMap(route => route.userGroups))];
  const [userRows, groupRows] = await Promise.all([
    userIds.length > 0
      ? db.selectFrom('users').select('id').where('id', 'in', userIds).execute()
      : [],
    groupIds.length > 0
      ? db
          .selectFrom('userGroups')
          .select('id')
          .where('id', 'in', groupIds)
          .execute()
      : []
  ]);
  const foundUsers = new Set(userRows.map(row => row.id));
  const foundGroups = new Set(groupRows.map(row => row.id));
  const missing = [
    ...userIds.filter(id => !foundUsers.has(id)),
    ...groupIds.filter(id => !foundGroups.has(id))
  ];
  if (missing.length > 0) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `unknown user or user group: ${missing.join(', ')}`
    );
  }
}

/**
 * Throws 422 for a duplicate `id` in `routes`, or one that names no route at all. A soft-deleted
 * route's id is accepted: an undo of a `replace` that dropped it (§5.8) replays its recorded
 * `from` through `replace` again, which un-deletes it by id.
 */
export async function assertRouteIdsLive(
  db: Db,
  routes: RouteAssertInput[]
): Promise<void> {
  const ids = routes
    .map(route => route.id)
    .filter((id): id is string => id !== undefined);
  const duplicates = [
    ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))
  ];
  if (duplicates.length > 0) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `duplicate route id: ${duplicates.join(', ')}`
    );
  }
  if (ids.length === 0) {
    return;
  }
  const rows = await db
    .selectFrom('outboundRoutes')
    .select('id')
    .where('id', 'in', ids)
    .execute();
  const found = new Set(rows.map(row => row.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length > 0) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `unknown route id: ${missing.join(', ')}`
    );
  }
}
