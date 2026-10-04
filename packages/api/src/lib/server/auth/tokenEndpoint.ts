import { epochSeconds, HTTP_BAD_REQUEST, HTTP_OK } from '@zamfono/shared';

import { notifyUsersChanged } from '../eventSink.js';
import type { AuthCodeStore } from './codes.js';
import { ACCESS_TOKEN_TTL_S, isRole, signAccessToken } from './jwt.js';
import {
  GRANT_AUTHORIZATION_CODE,
  GRANT_REFRESH_TOKEN,
  oauthError,
  readForm,
  type BaseDeps
} from './oauthHttp.js';
import { requestedResourceAcceptable } from './resource.js';
import { issueRefresh, rotateRefresh } from './tokens.js';

const BEARER_TOKEN_TYPE = 'Bearer';

export type TokenDeps = BaseDeps & {
  jwtSecret: string;
  codes: AuthCodeStore;
  /** The stack's own origin, `https://${FQDN}` (§6.3), which names the one resource tokens are issued for. */
  origin: string;
};

function tokenResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: BEARER_TOKEN_TYPE,
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken
    }),
    {
      status: HTTP_OK,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        pragma: 'no-cache'
      }
    }
  );
}

async function handleAuthorizationCode(
  deps: TokenDeps,
  params: URLSearchParams
): Promise<Response> {
  const code = params.get('code');
  const redirectUri = params.get('redirect_uri');
  const clientId = params.get('client_id');
  const codeVerifier = params.get('code_verifier');
  // `redirect_uri` may be absent: `redeem` then accepts only a code whose authorization request
  // omitted it too (OAuth 2.1 §10.2).
  if (code === null || clientId === null || codeVerifier === null) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_request');
  }
  const redeemed = deps.codes.redeem(code, codeVerifier, clientId, redirectUri);
  if (!redeemed) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_grant');
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'role'])
    .where('id', '=', redeemed.userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!user || !isRole(user.role)) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_grant');
  }
  const nowIso = deps.now();
  const nowS = epochSeconds(Date.parse(nowIso));
  const refresh = await issueRefresh(deps.db, user.id, clientId, nowIso);
  const accessToken = await signAccessToken(
    deps.jwtSecret,
    { sub: user.id, role: user.role, cid: clientId, sid: refresh.sessionId },
    nowS,
    deps.origin
  );
  return tokenResponse(accessToken, refresh.raw);
}

async function handleRefreshToken(
  deps: TokenDeps,
  params: URLSearchParams
): Promise<Response> {
  const refreshToken = params.get('refresh_token');
  if (refreshToken === null) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_request');
  }
  const nowIso = deps.now();
  const rotated = await rotateRefresh(deps.db, refreshToken, nowIso);
  if (!rotated.ok) {
    if (rotated.reason === 'replayed') {
      // §10.6: the revoked sessions' `/events` sockets close.
      notifyUsersChanged();
    }
    return oauthError(HTTP_BAD_REQUEST, 'invalid_grant');
  }
  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'role'])
    .where('id', '=', rotated.userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!user || !isRole(user.role)) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_grant');
  }
  const nowS = epochSeconds(Date.parse(nowIso));
  const accessToken = await signAccessToken(
    deps.jwtSecret,
    {
      sub: user.id,
      role: user.role,
      cid: rotated.clientId,
      sid: rotated.next.sessionId
    },
    nowS,
    deps.origin
  );
  return tokenResponse(accessToken, rotated.next.raw);
}

/**
 * `POST /oauth/token`: authorization_code (PKCE) or refresh_token grant (§5.2). The §5.5
 * per-address limit is the server hooks' (`hooks.server.ts`), which answer 429 before this runs.
 * A `resource` other than this stack's MCP server is refused before the grant is looked at, so
 * the code or refresh token survives for a corrected request (RFC 8707 §2, `resource.ts`).
 */
export async function tokenEndpoint(
  deps: TokenDeps,
  req: Request
): Promise<Response> {
  const params = await readForm(req);
  if (!requestedResourceAcceptable(deps.origin, params)) {
    return oauthError(HTTP_BAD_REQUEST, 'invalid_target');
  }
  const grantType = params.get('grant_type');
  if (grantType === GRANT_AUTHORIZATION_CODE) {
    return handleAuthorizationCode(deps, params);
  }
  if (grantType === GRANT_REFRESH_TOKEN) {
    return handleRefreshToken(deps, params);
  }
  return oauthError(HTTP_BAD_REQUEST, 'unsupported_grant_type');
}
