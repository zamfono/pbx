/**
 * Issues access tokens (§5.2) with the stack's `JWT_SECRET`. Kept apart from `jwt.ts`, the token
 * format and its verification, which `server.ts` also runs, for the `/events` handshake, outside
 * the SvelteKit bundle, where `$app/env/private` does not exist.
 */
import * as env from '$app/env/private';

import {
  ACCESS_TOKEN_TTL_S,
  encodeAccessToken,
  type AccessClaims
} from './jwt.js';
import { mcpResourceUri } from './resource.js';

/** The secret every access token is signed and verified with (§5.2 `JWT_SECRET`). */
export function requiredJwtSecret(): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required.');
  }
  return secret;
}

/**
 * Signs an HS256 access token issued by `origin`, the stack's own (`requiredOrigin()`), for its MCP server, the
 * one resource it issues tokens for (`resource.ts`): `exp` is `nowS + 900` (§5.2, §6.3).
 */
export function signAccessToken(
  secret: string,
  claims: AccessClaims,
  nowS: number,
  origin: string
): Promise<string> {
  return encodeAccessToken(secret, {
    ...claims,
    iss: origin,
    aud: mcpResourceUri(origin),
    iat: nowS,
    exp: nowS + ACCESS_TOKEN_TTL_S
  });
}
