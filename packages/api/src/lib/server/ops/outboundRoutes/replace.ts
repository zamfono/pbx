import { z } from 'zod';

import { newId, type Db } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import {
  assertCallerIdsNumeric,
  assertCallersExist,
  assertRouteIdsLive,
  assertTrunksLive
} from './_replaceChecks.js';
import { replaceInputSchema } from './_replaceInput.js';
import {
  loadRouteChildren,
  routeToWire,
  toRouteInput,
  type RouteWire
} from './_shared.js';

const inputSchema = replaceInputSchema;

type Input = z.infer<typeof inputSchema>;
type RouteInput = Input['routes'][number];
type Output = { items: RouteWire[] };

/** Replaces one route's callers and numbers as a whole (§11.2 "outbound_route_*"). */
async function replaceRouteChildren(
  db: Db,
  routeId: string,
  route: RouteInput
): Promise<void> {
  await db
    .deleteFrom('outboundRouteUsers')
    .where('routeId', '=', routeId)
    .execute();
  await db
    .deleteFrom('outboundRouteUserGroups')
    .where('routeId', '=', routeId)
    .execute();
  await db
    .deleteFrom('outboundRouteNumbers')
    .where('routeId', '=', routeId)
    .execute();
  if (route.users.length > 0) {
    await db
      .insertInto('outboundRouteUsers')
      .values(route.users.map(userId => ({ routeId, userId })))
      .execute();
  }
  if (route.userGroups.length > 0) {
    await db
      .insertInto('outboundRouteUserGroups')
      .values(route.userGroups.map(userGroupId => ({ routeId, userGroupId })))
      .execute();
  }
  if (route.numbers.length > 0) {
    await db
      .insertInto('outboundRouteNumbers')
      .values(
        route.numbers.map(number => ({
          routeId,
          number: number.number,
          isPrefix: number.isPrefix === true ? 1 : 0
        }))
      )
      .execute();
  }
}

/**
 * Moves every kept route to a temporary, mutually distinct negative priority: `priority` is
 * unique among live routes, so writing final positions in one pass could collide with a route
 * not yet moved off its current one (§11.2 "outbound_routes").
 */
async function parkKeptRoutesAtNegativePriority(
  db: Db,
  keptIds: string[]
): Promise<void> {
  await Promise.all(
    keptIds.map((id, index) =>
      db
        .updateTable('outboundRoutes')
        .set({ priority: -1 * (index + 1) })
        .where('id', '=', id)
        .execute()
    )
  );
}

async function softDeleteDroppedRoutes(
  db: Db,
  droppedIds: string[],
  now: string
): Promise<void> {
  if (droppedIds.length === 0) {
    return;
  }
  await db
    .updateTable('outboundRoutes')
    .set({ deletedAt: now })
    .where('id', 'in', droppedIds)
    .execute();
}

/** Every live route, in evaluation order, with its callers and numbers (§11.2 "outbound_route_*"). */
async function loadCurrentRoutes(db: Db): Promise<RouteWire[]> {
  const rows = await db
    .selectFrom('outboundRoutes')
    .selectAll()
    .where('deletedAt', 'is', null)
    .orderBy('priority')
    .execute();
  const children = await loadRouteChildren(
    db,
    rows.map(row => row.id)
  );
  return rows.map(row => routeToWire(row, children));
}

async function writeRoute(
  db: Db,
  route: RouteInput,
  priority: number,
  now: string
): Promise<string> {
  const calleridDidId = route.calleridDidId ?? null;
  if (route.id) {
    await db
      .updateTable('outboundRoutes')
      .set({
        trunkId: route.trunkId,
        calleridDidId,
        priority,
        deletedAt: null
      })
      .where('id', '=', route.id)
      .execute();
    await replaceRouteChildren(db, route.id, route);
    return route.id;
  }
  const id = newId();
  await db
    .insertInto('outboundRoutes')
    .values({
      id,
      priority,
      trunkId: route.trunkId,
      calleridDidId,
      createdAt: now
    })
    .execute();
  await replaceRouteChildren(db, id, route);
  return id;
}

export const replace = defineOperation<Input, Output>({
  name: 'outboundRoutes.replace',
  description:
    'Replaces the outbound route list as a whole, in evaluation order: a call takes the first route whose callers and numbers both match, falling through to the next when its trunk fails.',
  input: inputSchema,
  minRole: 'admin',
  entity: () => ({ kind: 'outboundRoute', id: null }),
  run: async (ctx, input) => {
    await assertTrunksLive(ctx.db, input.routes);
    await assertCallerIdsNumeric(ctx.db, input.routes);
    await assertCallersExist(ctx.db, input.routes);
    await assertRouteIdsLive(ctx.db, input.routes);

    const before = await loadCurrentRoutes(ctx.db);

    const keptIds = input.routes
      .map(route => route.id)
      .filter((id): id is string => id !== undefined);
    const keptIdSet = new Set(keptIds);
    const droppedIds = before
      .map(route => route.id)
      .filter(id => !keptIdSet.has(id));

    await softDeleteDroppedRoutes(ctx.db, droppedIds, ctx.now);
    await parkKeptRoutesAtNegativePriority(ctx.db, keptIds);
    await Promise.all(
      input.routes.map((route, index) =>
        writeRoute(ctx.db, route, index + 1, ctx.now)
      )
    );

    const after = await loadCurrentRoutes(ctx.db);
    // Recorded in `routeInputSchema`'s shape, which `outboundRoutes.replace` accepts, so an undo
    // replays `from` through this operation (§5.8).
    recordChange(ctx, {
      field: 'routes',
      from: before.map(toRouteInput),
      to: after.map(toRouteInput)
    });

    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { items: after };
  }
});
