/**
 * The access token to `Actor` step every authenticated channel shares (§5.2, §5.3): REST's
 * server hook, the MCP endpoint and the `/events` handshake. It never reads `$app/env/private`, since
 * `server.ts` runs the handshake outside the SvelteKit bundle.
 */
import { epochSeconds, type Db } from '@zamfono/shared';

import type { Actor } from '../ops/types.js';
import { isRole, verifyAccessToken, verifyDownloadToken } from './jwt.js';

export const BEARER_PREFIX = 'Bearer ';
/** The query parameter a download link carries its token in (RFC 6750 §2.3, §10.5). */
export const ACCESS_TOKEN_PARAM = 'access_token';

/** The user a request acts as, and the OAuth client and its name it acts through, if any (§5.7). */
export type Authenticated = {
  actor: Actor;
  clientId?: string;
  clientName?: string;
};

export type BearerDeps = { db: Db; jwtSecret: string };

/** The user `claims` names, read fresh from `users`, and the OAuth client it acts through. */
async function liveAuthenticated(
  deps: BearerDeps,
  claims: { sub: string; cid: string | null }
): Promise<Authenticated | null> {
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
  return claims && liveAuthenticated(deps, claims);
}

/**
 * The live user behind download link `url` (§10.5): its `access_token` query parameter, a
 * download-link token issued for `url`'s path; `null` without one or for one that fails, as
 * `authenticateToken` decides.
 */
export async function authenticateDownloadLink(
  deps: BearerDeps,
  url: URL
): Promise<Authenticated | null> {
  const token = url.searchParams.get(ACCESS_TOKEN_PARAM);
  if (token === null) {
    return null;
  }
  const nowS = epochSeconds(Date.now());
  const claims = await verifyDownloadToken(
    deps.jwtSecret,
    token,
    nowS,
    url.pathname
  );
  return claims && liveAuthenticated(deps, claims);
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
