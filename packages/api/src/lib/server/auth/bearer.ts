/**
 * The access token to `Actor` step every authenticated channel shares (§5.2, §5.3): REST's
 * server hook, the MCP endpoint and the `/events` handshake. It never reads `$app/env/private`, since
 * `server.ts` runs the handshake outside the SvelteKit bundle.
 */
import { epochSeconds, type Db } from '@zamfono/shared';

import type { Actor } from '../ops/types.js';
import { isRole, verifyAccessToken } from './jwt.js';

const BEARER_PREFIX = 'Bearer ';

/** The user a request acts as, and the OAuth client and its name it acts through, if any (§5.7). */
export type Authenticated = {
  actor: Actor;
  clientId?: string;
  clientName?: string;
};

export type BearerDeps = { db: Db; jwtSecret: string };

/**
 * The live user behind access token `token`, read fresh from `users` so a role change takes
 * effect before the token's 15 minutes run out; `null` for a token that fails verification or
 * was not issued for `audience` when one is given, a soft-deleted user, or a stored role that is
 * none of the three (§5.3).
 */
export async function authenticateToken(
  deps: BearerDeps,
  token: string,
  audience?: string
): Promise<Authenticated | null> {
  const nowS = epochSeconds(Date.now());
  const claims = await verifyAccessToken(deps.jwtSecret, token, nowS, audience);
  if (!claims) {
    return null;
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'name', 'role'])
    .where('id', '=', claims.sub)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!user || !isRole(user.role)) {
    return null;
  }
  const actor = { id: user.id, name: user.name, role: user.role };
  if (claims.cid === null) {
    return { actor };
  }
  const client = await deps.db
    .selectFrom('oauthClients')
    .select('name')
    .where('clientId', '=', claims.cid)
    .executeTakeFirst();
  return { actor, clientId: claims.cid, clientName: client?.name };
}

/** `authenticateToken` for the bearer token of `request`'s `Authorization` header; `null` without one. */
export function authenticateRequest(
  deps: BearerDeps,
  request: Request,
  audience?: string
): Promise<Authenticated | null> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith(BEARER_PREFIX)) {
    return Promise.resolve(null);
  }
  return authenticateToken(deps, header.slice(BEARER_PREFIX.length), audience);
}
