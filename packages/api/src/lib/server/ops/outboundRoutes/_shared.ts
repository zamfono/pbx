import type { Selectable } from 'kysely';

import type { Db, DB } from '@zamfono/shared';

export type RouteRow = Selectable<DB['outboundRoutes']>;

export type NumberWire = { number: string; isPrefix: boolean };

export type RouteWire = {
  id: string;
  priority: number;
  trunkId: string;
  callerIdDidId: string | null;
  users: string[];
  userGroups: string[];
  numbers: NumberWire[];
};

/** One route's users, user groups and numbers, keyed by `routeId` (§11.2 "outbound_route_*"). */
export type RouteChildren = {
  users: Map<string, string[]>;
  userGroups: Map<string, string[]>;
  numbers: Map<string, NumberWire[]>;
};

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export async function loadRouteChildren(
  db: Db,
  routeIds: string[]
): Promise<RouteChildren> {
  const children: RouteChildren = {
    users: new Map(),
    userGroups: new Map(),
    numbers: new Map()
  };
  if (routeIds.length === 0) {
    return children;
  }
  const [users, userGroups, numbers] = await Promise.all([
    db
      .selectFrom('outboundRouteUsers')
      .selectAll()
      .where('routeId', 'in', routeIds)
      .execute(),
    db
      .selectFrom('outboundRouteUserGroups')
      .selectAll()
      .where('routeId', 'in', routeIds)
      .execute(),
    db
      .selectFrom('outboundRouteNumbers')
      .selectAll()
      .where('routeId', 'in', routeIds)
      .execute()
  ]);
  for (const row of users) {
    pushInto(children.users, row.routeId, row.userId);
  }
  for (const row of userGroups) {
    pushInto(children.userGroups, row.routeId, row.userGroupId);
  }
  for (const row of numbers) {
    pushInto(children.numbers, row.routeId, {
      number: row.number,
      isPrefix: row.isPrefix === 1
    });
  }
  return children;
}

export function routeToWire(row: RouteRow, children: RouteChildren): RouteWire {
  return {
    id: row.id,
    priority: row.priority,
    trunkId: row.trunkId,
    callerIdDidId: row.callerIdDidId,
    users: children.users.get(row.id) ?? [],
    userGroups: children.userGroups.get(row.id) ?? [],
    numbers: children.numbers.get(row.id) ?? []
  };
}

/**
 * A route in `outboundRoutes.replace`'s own input shape: `RouteWire` without `priority`, since
 * position in the array carries it (§9.4 "Outbound routing"). Used to record an audit diff that
 * an undo can replay through `outboundRoutes.replace` itself (§5.8).
 */
export type RouteInputWire = {
  id: string;
  trunkId: string;
  callerIdDidId: string | null;
  users: string[];
  userGroups: string[];
  numbers: NumberWire[];
};

export function toRouteInput(route: RouteWire): RouteInputWire {
  return {
    id: route.id,
    trunkId: route.trunkId,
    callerIdDidId: route.callerIdDidId,
    users: route.users,
    userGroups: route.userGroups,
    numbers: route.numbers
  };
}
