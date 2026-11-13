/**
 * The bearer token to `Actor` step every authenticated channel shares (§5.2, §5.3): REST's
 * server hook, the MCP endpoint and the `/events` handshake. It never reads `$app/env/private`, since
 * `server.ts` runs the handshake outside the SvelteKit bundle.
 */
import { timingSafeEqual } from 'node:crypto';

import { epochSeconds, nowIso, type Db } from '@zamfono/shared';

import type { Actor } from '../ops/types.js';
import { verifyAccessToken, verifyLinkToken, type LinkKind } from './jwt.js';
import { loginUser } from './loginUser.js';
import {
  livePersonalAccessToken,
  PAT_PREFIX,
  type PersonalAccessTokenGrant
} from './personalAccessTokens.js';
import { liveSessionIds } from './tokens.js';

export const BEARER_PREFIX = 'Bearer ';

/** Whether `authorization` is exactly `Bearer <token>`, compared in constant time (§7 `METRICS_TOKEN`: a static shared secret, so a byte-by-byte comparison would leak it through timing). */
export function isValidBearer(
  authorization: string | null,
  token: string
): boolean {
  const expected = Buffer.from(`${BEARER_PREFIX}${token}`);
  const actual = Buffer.from(authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** The query parameter a download or upload link carries its token in (RFC 6750 §2.3, §10.5). */
export const ACCESS_TOKEN_PARAM = 'access_token';

/**
 * The user a request acts as, and the OAuth client and its name it acts through, if any (§5.7),
 * with the session of its access token or the personal access token it presented (§5.2).
 */
export type Authenticated = {
  actor: Actor;
  clientId?: string;
  clientName?: string;
  personalAccessToken?: PersonalAccessTokenGrant;
  /** The session an access token was issued in (§5.2), which an `/events` socket lives by. */
  sessionId?: string;
  /** The user's `credential_epoch` (§5.2), which a link minted for this request carries; absent
   *  for a voice bot's session token, which acts for no user. */
  credentialEpoch?: number;
};

export type BearerDeps = { db: Db; jwtSecret: string };

/** The user `claims` names, read fresh from `users`, and the OAuth client it acts through;
 *  given an `ep` claim, `null` once the user's `credential_epoch` has moved on (`loginUser`). */
async function liveAuthenticated(
  deps: BearerDeps,
  claims: { sub: string; cid: string | null; ep?: number }
): Promise<Authenticated | null> {
  const user = await loginUser(deps.db, claims.sub, claims.ep);
  if (!user) {
    return null;
  }
  const { credentialEpoch, ...actor } = user;
  if (claims.cid === null) {
    return { actor, credentialEpoch };
  }
  const client = await deps.db
    .selectFrom('oauthClients')
    .select('name')
    .where('clientId', '=', claims.cid)
    .executeTakeFirst();
  return {
    actor,
    credentialEpoch,
    clientId: claims.cid,
    clientName: client?.name
  };
}

/**
 * The live user behind bearer token `token`, read fresh from `users` so a role change takes
 * effect at once: a personal access token's user (§5.2), or an access token's, which fails
 * unless issued for `audience` when one is given; `null` for a token that fails verification, an
 * access token whose session has ended (§5.2), or a user `loginUser` refuses.
 */
export async function authenticateToken(
  deps: BearerDeps,
  token: string,
  audience?: string
): Promise<Authenticated | null> {
  if (token.startsWith(PAT_PREFIX)) {
    const pat = await livePersonalAccessToken(deps.db, token, nowIso());
    if (pat === null) {
      return null;
    }
    // The epoch the token was read live at: a password or MFA reset since then, which revoked
    // it, refuses it here, rather than let the request carry the reset's epoch (§5.2).
    const auth = await liveAuthenticated(deps, {
      sub: pat.userId,
      cid: null,
      ep: pat.credentialEpoch ?? undefined
    });
    return (
      auth && {
        ...auth,
        actor: { ...auth.actor, personalAccessTokenId: pat.id },
        personalAccessToken: { id: pat.id, expiresAt: pat.expiresAt }
      }
    );
  }
  const nowS = epochSeconds(Date.now());
  const claims = await verifyAccessToken(deps.jwtSecret, token, nowS, audience);
  if (!claims) {
    return null;
  }
  const [auth, liveSessions] = await Promise.all([
    liveAuthenticated(deps, claims),
    liveSessionIds(deps.db, [claims.sid], nowIso())
  ]);
  return auth && liveSessions.has(claims.sid)
    ? { ...auth, sessionId: claims.sid }
    : null;
}

/**
 * The live user behind link `url` of `kind` (§10.5): its `access_token` query parameter, a link
 * token of that kind issued for `path`, by default `url`'s own; `null` without one, for one that
 * fails, as `authenticateToken` decides, or for one minted before the user's `credential_epoch`
 * last moved (§5.2).
 */
export async function authenticateLink(
  deps: BearerDeps,
  kind: LinkKind,
  url: URL,
  path = url.pathname
): Promise<Authenticated | null> {
  const token = url.searchParams.get(ACCESS_TOKEN_PARAM);
  if (token === null) {
    return null;
  }
  const nowS = epochSeconds(Date.now());
  const claims = await verifyLinkToken(deps.jwtSecret, kind, token, nowS, path);
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
