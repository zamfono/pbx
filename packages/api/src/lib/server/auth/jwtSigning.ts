/**
 * Issues access tokens (§5.2) with the stack's `JWT_SECRET` and `ORIGIN`. Kept apart from
 * `jwt.ts`, the token format and its verification, which `server.ts` also runs, for the `/events`
 * handshake, outside the SvelteKit bundle, where `$env` does not exist.
 */
import { env } from '$env/dynamic/private';

import {
  ACCESS_TOKEN_TTL_S,
  encodeAccessToken,
  type AccessClaims
} from './jwt.js';

/** The secret every access token is signed and verified with (§5.2 `JWT_SECRET`). */
export function requiredJwtSecret(): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required.');
  }
  return secret;
}

/**
 * Signs an HS256 access token for `audience`: `exp` is `nowS + 900`, `iss` is the stack's `ORIGIN`
 * (§5.2, §6.3).
 */
export function signAccessToken(
  secret: string,
  claims: AccessClaims,
  nowS: number,
  audience: string
): string {
  return encodeAccessToken(secret, {
    ...claims,
    iss: env.ORIGIN ?? '',
    aud: audience,
    iat: nowS,
    exp: nowS + ACCESS_TOKEN_TTL_S
  });
}
