import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import '../trunks/index.js';
import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(): { actor: Actor; channel: 'rest'; requestId: string } {
  return { actor: owner, channel: 'rest', requestId: 'req-1' };
}

type TrunkOutput = { trunk: { id: string } };
type RouteWire = {
  id: string;
  priority: number;
  trunkId: string;
  numbers: { number: string; isPrefix: boolean }[];
};
type RoutesOutput = { items: RouteWire[] };

async function createTrunkAndCatchAll(
  db: Db
): Promise<{ trunkId: string; routeId: string }> {
  const { trunk } = await runOperation<unknown, TrunkOutput>(
    db,
    'trunks.create',
    {
      name: 'Provider A',
      emergency: true,
      authMode: 'ip',
      hosts: [{ host: 'sip.provider.example' }]
    },
    asRun()
  );
  const { items } = await runOperation<unknown, RoutesOutput>(
    db,
    'outboundRoutes.list',
    {},
    asRun()
  );
  const [catchAll] = items;
  if (catchAll === undefined) {
    throw new Error('outboundRoutes test: expected the catch-all route');
  }
  return { trunkId: trunk.id, routeId: catchAll.id };
}

describe('outboundRoutes operations', () => {
  it('replace keeps an existing route id and stores its E.164 numbers', async () => {
    const db = await makeTestDb();
    const { trunkId, routeId } = await createTrunkAndCatchAll(db);

    const { items } = await runOperation<unknown, RoutesOutput>(
      db,
      'outboundRoutes.replace',
      {
        routes: [
          {
            id: routeId,
            trunkId,
            users: [],
            userGroups: [],
            numbers: [{ number: '+491701234567', isPrefix: false }]
          }
        ]
      },
      asRun()
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: routeId,
      priority: 1,
      numbers: [{ number: '+491701234567', isPrefix: false }]
    });
  });

  it('replace records the prior and new route lists in the audit diff', async () => {
    const db = await makeTestDb();
    const { trunkId, routeId } = await createTrunkAndCatchAll(db);

    await runOperation<unknown, RoutesOutput>(
      db,
      'outboundRoutes.replace',
      {
        routes: [
          {
            id: routeId,
            trunkId,
            users: [],
            userGroups: [],
            numbers: [{ number: '+491701234567', isPrefix: false }]
          }
        ]
      },
      asRun()
    );

    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'outboundRoutes.replace')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: RouteWire[];
      to: RouteWire[];
    }[];
    const routesChange = changes.find(change => change.field === 'routes');
    expect(routesChange?.from).toMatchObject([{ id: routeId, numbers: [] }]);
    expect(routesChange?.to).toMatchObject([
      { id: routeId, numbers: [{ number: '+491701234567' }] }
    ]);
    // `priority` is carried by array position, so neither recorded value declares it.
    expect(routesChange?.from[0]).not.toHaveProperty('priority');
    expect(routesChange?.to[0]).not.toHaveProperty('priority');

    // Undo replays `from` through the normal operation; this must validate (§5.8).
    const { items } = await runOperation<unknown, RoutesOutput>(
      db,
      'outboundRoutes.replace',
      { routes: routesChange?.from },
      asRun()
    );
    expect(items).toMatchObject([{ id: routeId, numbers: [] }]);
  });

  it('undo restores a route a later replace dropped, live with its callers and numbers (§5.8)', async () => {
    const db = await makeTestDb();
    const { trunkId, routeId } = await createTrunkAndCatchAll(db);

    // `outboundRoutes.replace` writes routes in input order, so `firstReplace[1]` is the second
    // route's assigned id.
    const { items: firstReplace } = await runOperation<unknown, RoutesOutput>(
      db,
      'outboundRoutes.replace',
      {
        routes: [
          {
            id: routeId,
            trunkId,
            users: [],
            userGroups: [],
            numbers: [{ number: '+491701234567', isPrefix: false }]
          },
          { trunkId, users: [], userGroups: [], numbers: [] }
        ]
      },
      asRun()
    );
    const [, second] = firstReplace;
    if (second === undefined) {
      throw new Error('outboundRoutes test: expected a second route');
    }
    const keptRouteId = second.id;

    // Drops `routeId`, keeping only `keptRouteId`.
    await runOperation<unknown, RoutesOutput>(
      db,
      'outboundRoutes.replace',
      {
        routes: [
          { id: keptRouteId, trunkId, users: [], userGroups: [], numbers: [] }
        ]
      },
      asRun()
    );

    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'outboundRoutes.replace')
      .orderBy('createdAt', 'desc')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: RouteWire[];
    }[];
    const from = changes.find(change => change.field === 'routes')?.from;
    expect(from?.some(route => route.id === routeId)).toBe(true);

    const { items } = await runOperation<unknown, RoutesOutput>(
      db,
      'outboundRoutes.replace',
      { routes: from },
      asRun()
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        id: routeId,
        numbers: [{ number: '+491701234567', isPrefix: false }]
      })
    );
  });

  it('replace refuses a duplicate route id in the input', async () => {
    const db = await makeTestDb();
    const { trunkId, routeId } = await createTrunkAndCatchAll(db);

    await expect(
      runOperation(
        db,
        'outboundRoutes.replace',
        {
          routes: [
            { id: routeId, trunkId, users: [], userGroups: [], numbers: [] },
            { id: routeId, trunkId, users: [], userGroups: [], numbers: [] }
          ]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('replace refuses a duplicate user id in one route', async () => {
    const db = await makeTestDb();
    const { trunkId } = await createTrunkAndCatchAll(db);

    await expect(
      runOperation(
        db,
        'outboundRoutes.replace',
        {
          routes: [
            {
              trunkId,
              users: ['u1', 'u1'],
              userGroups: [],
              numbers: []
            }
          ]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('replace refuses a duplicate user group id in one route', async () => {
    const db = await makeTestDb();
    const { trunkId } = await createTrunkAndCatchAll(db);

    await expect(
      runOperation(
        db,
        'outboundRoutes.replace',
        {
          routes: [
            {
              trunkId,
              users: [],
              userGroups: ['g1', 'g1'],
              numbers: []
            }
          ]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('replace refuses an unknown user id as a 422, not a raw FK error', async () => {
    const db = await makeTestDb();
    const { trunkId } = await createTrunkAndCatchAll(db);

    await expect(
      runOperation(
        db,
        'outboundRoutes.replace',
        {
          routes: [
            {
              trunkId,
              users: ['does-not-exist'],
              userGroups: [],
              numbers: []
            }
          ]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('replace refuses a number that is not E.164', async () => {
    const db = await makeTestDb();
    const { trunkId } = await createTrunkAndCatchAll(db);

    await expect(
      runOperation(
        db,
        'outboundRoutes.replace',
        {
          routes: [
            {
              trunkId,
              users: [],
              userGroups: [],
              numbers: [{ number: '0891234567', isPrefix: false }]
            }
          ]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  // §10.3 "Conventions": list endpoints paginate with `?limit=` and an opaque `?cursor=`.
  it('list pages through the routes in evaluation order with limit and cursor', async () => {
    const db = await makeTestDb();
    const { trunkId, routeId } = await createTrunkAndCatchAll(db);
    await runOperation(
      db,
      'outboundRoutes.replace',
      {
        routes: [
          {
            trunkId,
            users: [],
            userGroups: [],
            numbers: [{ number: '+4930', isPrefix: true }]
          },
          { id: routeId, trunkId, users: [], userGroups: [], numbers: [] }
        ]
      },
      asRun()
    );
    type Page = {
      items: { id: string; numbers: unknown[] }[];
      nextCursor: string | null;
    };

    const one = await runOperation<unknown, Page>(
      db,
      'outboundRoutes.list',
      { limit: 1 },
      asRun()
    );
    expect(one.items).toHaveLength(1);
    const [onlyItem] = one.items;
    if (onlyItem === undefined) {
      throw new Error('outboundRoutes test: expected one item');
    }
    expect(onlyItem.numbers).toHaveLength(1);
    expect(one.nextCursor).toEqual(expect.any(String));

    const two = await runOperation<unknown, Page>(
      db,
      'outboundRoutes.list',
      { limit: 1, cursor: one.nextCursor },
      asRun()
    );
    expect(two.items.map(item => item.id)).toEqual([routeId]);
    expect(two.nextCursor).toBeNull();
  });
});
