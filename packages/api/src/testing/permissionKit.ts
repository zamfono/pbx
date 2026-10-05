import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';

import {
  epochSeconds,
  HTTP_OK,
  nowIso,
  type Db,
  type UserRole
} from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { signAccessToken } from '#lib/server/auth/jwt.js';
import { getDb } from '#lib/server/db.js';
import { sha256Hex } from '#lib/server/hash.js';
import { handleMcpRequest } from '#lib/server/mcp.js';
import type { ErasedOperation } from '#lib/server/ops/registry.js';
import type { RouteEntry } from '#lib/server/restRoutes.js';
import {
  currentHeaders,
  currentMeta,
  JWT_SECRET,
  mcpRequest,
  ORIGIN
} from '#testing/mcp/testKit.js';
import { requestEvent } from '#testing/requestEvent.js';

import { seedSession } from './testDb.js';

// The permission matrix's fixtures (`../permissionMatrix.test.ts`): the principals that call, what
// their calls name and how they are made, and every operation reduced to its gates.

/**
 * Every id a call names is `TARGET_ID`, which is the owner's account, a token of the owner's and
 * the audit entry of an admin's soft delete, and its input asks for an admin, so each owner-only
 * call is one (§10.3).
 */
const TARGET_ID = 'owner';
const TARGET_INPUT = { id: TARGET_ID, userId: TARGET_ID, role: 'admin' };

const REACHED = { reached: true };

/** `op` reduced to its gates: any input, no own scope, no confirmation, its owner-only check, no
 *  `prepare` and a run that only reports it was reached. Own scope has its own matrix (`lib/server/ops/ownScope.test.ts`). */
export function stubbed(op: ErasedOperation): ErasedOperation {
  return {
    ...op,
    // `upload` is named so an upload operation's MCP link can leave it out (§10.5 "Uploads").
    input: z.looseObject({ upload: z.unknown().optional() }),
    output: z.unknown(),
    ...(op.minRole === 'user' ? { scope: 'any' } : {}),
    confirm: undefined,
    readOnly: true,
    prepare: undefined,
    run: () => Promise.resolve(REACHED)
  };
}

/** A caller: its bearer token (`''` for none) and the role it acts as, `null` when refused. */
export type Principal = {
  name: string;
  token: string;
  actsAs: UserRole | null;
};

const EXPIRED_AGE_S = 3600;
function liveSession(sub: string): string {
  return `session-${sub}`;
}
const ENDED_SESSION = 'session-ended';

async function jwt(
  sub: string,
  role: UserRole,
  { ageS = 0, sid = liveSession(sub) } = {}
): Promise<string> {
  const iat = epochSeconds(Date.now()) - ageS;
  return signAccessToken(
    JWT_SECRET,
    { sub, role, cid: null, sid },
    iat,
    ORIGIN
  );
}

async function seedPat(db: Db, id: string, userId: string, extra = {}) {
  await db
    .insertInto('personalAccessTokens')
    .values({
      id,
      userId,
      name: id,
      tokenHash: sha256Hex(`zpat_${id}`),
      createdAt: nowIso(),
      ...extra
    })
    .execute();
}

const USERS = [
  ['owner', 'owner'],
  ['admin', 'admin'],
  ['user', 'user'],
  ['demoted', 'user'],
  ['deleted', 'user']
] as const;

/** Seeds the principals' users, sessions and tokens and what `TARGET_ID` names into `db`. */
export async function seedPrincipals(db: Db): Promise<Principal[]> {
  await Promise.all(
    USERS.map(([id, role]) => seedUser(db, { id, role, passwordHash: 'x' }))
  );
  await Promise.all(
    USERS.map(([id]) => seedSession(db, id, 'console', liveSession(id)))
  );
  await seedSession(db, 'owner', 'console', ENDED_SESSION);
  await db
    .updateTable('tokens')
    .set({ revokedAt: nowIso() })
    .where('sessionId', '=', ENDED_SESSION)
    .execute();
  await db
    .updateTable('users')
    .set({ deletedAt: nowIso() })
    .where('id', '=', 'deleted')
    .execute();
  await Promise.all([
    seedPat(db, TARGET_ID, 'owner'),
    seedPat(db, 'user', 'user'),
    seedPat(db, 'demoted', 'demoted'),
    seedPat(db, 'deleted', 'deleted'),
    seedPat(db, 'expired', 'user', { expiresAt: '2000-01-01T00:00:00.000Z' }),
    seedPat(db, 'revoked', 'user', { revokedAt: nowIso() })
  ]);
  await db
    .insertInto('auditLog')
    .values({
      id: TARGET_ID,
      actorUserId: 'owner',
      actorUserName: 'Owner',
      channel: 'rest',
      operation: 'users.delete',
      entityKind: 'user',
      entityId: 'admin',
      changesJson: '[]',
      undoable: 1,
      createdAt: nowIso()
    })
    .execute();
  return [
    { name: 'owner', token: await jwt('owner', 'owner'), actsAs: 'owner' },
    { name: 'admin', token: await jwt('admin', 'admin'), actsAs: 'admin' },
    { name: 'user', token: await jwt('user', 'user'), actsAs: 'user' },
    { name: 'user PAT', token: 'zpat_user', actsAs: 'user' },
    // Issued while they were admin; the role they hold now decides (§5.3).
    { name: 'demoted', token: await jwt('demoted', 'admin'), actsAs: 'user' },
    { name: 'demoted PAT', token: 'zpat_demoted', actsAs: 'user' },
    { name: 'deleted', token: await jwt('deleted', 'user'), actsAs: null },
    { name: 'deleted PAT', token: 'zpat_deleted', actsAs: null },
    { name: 'expired PAT', token: 'zpat_expired', actsAs: null },
    { name: 'revoked PAT', token: 'zpat_revoked', actsAs: null },
    {
      name: 'expired JWT',
      token: await jwt('owner', 'owner', { ageS: EXPIRED_AGE_S }),
      actsAs: null
    },
    // Its session signed out (§5.2).
    {
      name: 'ended session',
      token: await jwt('owner', 'owner', { sid: ENDED_SESSION }),
      actsAs: null
    },
    { name: 'no token', token: '', actsAs: null }
  ];
}

const UPLOAD_BYTES = new Uint8Array([0]);

/** A request to `route` that every stubbed operation accepts: a JSON or multipart body. */
export function restEvent(route: RouteEntry, token: string): RequestEvent {
  const path = route.pattern.replaceAll(/\{[^}]+\}/gu, TARGET_ID);
  const headers: Record<string, string> =
    token === '' ? {} : { authorization: `Bearer ${token}` };
  let body: BodyInit | undefined;
  if (route.multipart) {
    const form = new FormData();
    form.append('upload', new File([UPLOAD_BYTES], 'g.wav'));
    body = form;
  } else if (route.method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ role: TARGET_INPUT.role });
  }
  return requestEvent(`${ORIGIN}/api/v1${path}`, {
    init: { method: route.method, headers, body },
    routeId: '/api/v1/[...path]'
  });
}

/** The status `token` gets calling tool `name`: the HTTP 401, a tool error's problem status, or
 *  200 for a result. */
export async function mcpStatus(name: string, token: string): Promise<number> {
  const params = { name, arguments: TARGET_INPUT };
  const response = await handleMcpRequest(
    { db: getDb(), jwtSecret: JWT_SECRET, origin: ORIGIN },
    mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { ...params, _meta: currentMeta() }
      },
      token === ''
        ? { ...currentHeaders('tools/call', params), authorization: '' }
        : currentHeaders('tools/call', params),
      token
    )
  );
  if (response.status !== HTTP_OK) {
    return response.status;
  }
  const body = (await response.json()) as {
    result: { isError: boolean; structuredContent: { status?: number } };
  };
  return body.result.isError
    ? (body.result.structuredContent.status ?? 0)
    : HTTP_OK;
}
