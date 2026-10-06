import { beforeAll, describe, expect, it } from 'vitest';

import {
  HTTP_FORBIDDEN,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  type UserRole
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/server/db.js';
import { registry, type ErasedOperation } from '#lib/server/ops/registry.js';
import { routes, type RouteEntry } from '#lib/server/restRoutes.js';
import { JWT_SECRET } from '#testing/mcp/testKit.js';
import {
  mcpStatus,
  restEvent,
  seedPrincipals,
  stubbed,
  type Principal
} from '#testing/permissionKit.js';

import { handle } from './hooks.server.js';
import * as catchAll from './routes/api/v1/[...path]/+server.js';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = JWT_SECRET;

// Who may call what (§5.2, §5.3, §10.3): every route and every MCP tool against every principal,
// on what the spec declares, through the hook that authenticates and the gates every call passes.

const OWNER_OPS = new Set([
  'provisioning.ringotelAdopt',
  'provisioning.ringotelOptions',
  'provisioning.ringotelSetup',
  'system.update',
  'users.erase'
]);
const USER_ANY_OPS = new Set([
  'calls.decline',
  'calls.pickup',
  'contacts.get',
  'contacts.list',
  'parking.list',
  'search.query',
  'system.info',
  'voicemails.list'
]);
const USER_OWN_AREAS = ['hours', 'ooo', 'personalAccessTokens'];
const USER_OWN_OPS = new Set([
  ...['addParty', 'consult', 'get', 'hangup', 'hold', 'list', 'originate']
    .concat(['park', 'resume', 'transfer'])
    .map(op => `calls.${op}`),
  ...['clearVoicemailGreeting', 'getForwarding', 'get', 'setForwarding']
    .concat(['setPresence', 'setVoicemailGreeting', 'update'])
    .map(op => `users.${op}`),
  ...['create', 'delete', 'getBlf', 'list', 'setBlf', 'update'].map(
    op => `devices.${op}`
  ),
  ...['audio', 'delete', 'markRead'].map(op => `voicemails.${op}`)
]);
/** The calls only an owner makes when they name an owner, or create or restore an admin (§10.3). */
const OWNER_ONLY_OPS = new Set([
  'audit.undo',
  'personalAccessTokens.create',
  'personalAccessTokens.list',
  'personalAccessTokens.revoke',
  'users.create',
  'users.delete',
  'users.resetMfa',
  'users.resetPassword'
]);

/** Each operation's minimum role, and for a `user` operation whether it is own-scoped. */
type Declared = 'owner' | 'admin' | 'user:any' | 'user:own';

/** What the spec declares for operation `name`; every operation not listed is admin's. */
function specDeclared(name: string): Declared {
  if (OWNER_OPS.has(name)) {
    return 'owner';
  }
  if (USER_ANY_OPS.has(name)) {
    return 'user:any';
  }
  const area = name.slice(0, name.indexOf('.'));
  return USER_OWN_OPS.has(name) || USER_OWN_AREAS.includes(area)
    ? 'user:own'
    : 'admin';
}

function registryDeclared(op: ErasedOperation): Declared {
  if (op.minRole !== 'user') {
    return op.minRole;
  }
  return op.scope === 'any' ? 'user:any' : 'user:own';
}

const RANK: Record<UserRole, number> = { owner: 0, admin: 1, user: 2 };

/** Whether `role` passes the role gate of an operation declared `declared`. */
function roleAllows(declared: Declared, role: UserRole): boolean {
  const minRole = declared.startsWith('user') ? 'user' : declared;
  return RANK[role] <= RANK[minRole as UserRole];
}

/** The status `principal` gets calling operation `name` naming what the kit's calls name. */
function expectedStatus(name: string, principal: Principal): number {
  const role = principal.actsAs;
  if (role === null) {
    return HTTP_UNAUTHORIZED;
  }
  if (!roleAllows(specDeclared(name), role)) {
    return HTTP_FORBIDDEN;
  }
  return OWNER_ONLY_OPS.has(name) && role !== 'owner'
    ? HTTP_FORBIDDEN
    : HTTP_OK;
}

// The test kit's own `test.*` operations are no part of the product.
const ops = [...registry.values()].filter(op => !op.name.startsWith('test.'));
// Read before `beforeAll` reduces every operation to its gates.
const declared = new Map(ops.map(op => [op.name, registryDeclared(op)]));

describe('the registry declares what the spec says (§5.3, §10.3)', () => {
  it.each(ops.map(op => op.name))('%s', name => {
    expect(declared.get(name)).toBe(specDeclared(name));
  });

  it('declares the owner-only calls', () => {
    const ownerOnly = ops.filter(op => op.ownerOnly).map(op => op.name);
    expect(ownerOnly.sort()).toEqual([...OWNER_ONLY_OPS].sort());
  });

  it('routes every operation over REST', () => {
    const unrouted = ops.filter(
      op => !routes.some(route => route.op === op.name)
    );
    expect(unrouted.map(op => op.name)).toEqual([]);
  });
});

let principals: Principal[] = [];

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  principals = await seedPrincipals(db);
  for (const op of ops) {
    registry.set(op.name, stubbed(op));
  }
});

/** The HTTP status `token` gets on `route`, through the hook and the REST catch-all. */
async function restStatus(route: RouteEntry, token: string): Promise<number> {
  const response = await handle({
    event: restEvent(route, token),
    resolve: event => catchAll[route.method](event)
  });
  return response.status;
}

/** Each principal's status calling `name` through `call`, and the one the spec expects. */
async function cells(
  name: string,
  call: (token: string) => Promise<number>
): Promise<{
  actual: Record<string, number>;
  expected: Record<string, number>;
}> {
  const actual = await Promise.all(
    principals.map(
      async principal => [principal.name, await call(principal.token)] as const
    )
  );
  return {
    actual: Object.fromEntries(actual),
    expected: Object.fromEntries(
      principals.map(principal => [
        principal.name,
        expectedStatus(name, principal)
      ])
    )
  };
}

describe('REST: every route against every principal (§5.2, §5.3)', () => {
  it.each(
    routes.map(route => [`${route.method} ${route.pattern}`, route] as const)
  )('%s', async (_label, route) => {
    const { actual, expected } = await cells(route.op, token =>
      restStatus(route, token)
    );
    expect(actual).toEqual(expected);
  });
});

describe('MCP: every tool against every principal (§10.5)', () => {
  it.each(ops.map(op => op.name))('%s', async name => {
    const { actual, expected } = await cells(name, token =>
      mcpStatus(name, token)
    );
    expect(actual).toEqual(expected);
  });
});
