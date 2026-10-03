import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { MS_PER_SECOND } from '@zamfono/shared';

import type { Role } from '../ops/types.js';

// §5.2: an access token lives 15 minutes; `api` is the only party that ever verifies it, so
// there is no JWKS and no asymmetric key pair.
export const ACCESS_TOKEN_TTL_S = 900;
const JWT_ALG = 'HS256';
const JWT_TYP = 'JWT';

/** The identity an access token carries: the user, their role and the OAuth client, if any. */
export type AccessClaims = { sub: string; role: Role; cid: string | null };

/** Type guard for the RBAC roles a JWT `role` claim (or a `users.role` column) may hold. */
export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'user';
}

/** The claims as signed: `aud` is the RFC 8707 resource the token was issued for (`resource.ts`). */
const AccessPayloadSchema = z.object({
  sub: z.string(),
  role: z.custom<Role>(isRole),
  cid: z.string().nullable(),
  iss: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number()
});

export type AccessPayload = z.infer<typeof AccessPayloadSchema>;

function keyFor(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Encodes `payload` as an HS256 access token signed with `secret`, its claims in `payload`'s own
 * order. `jwtSigning.ts` builds the payload and reads the secret from the environment, which this
 * module never does: `server.ts` verifies tokens through it outside the SvelteKit bundle, where
 * there is no `$app/env/private`.
 */
export function encodeAccessToken(
  secret: string,
  payload: AccessPayload
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG, typ: JWT_TYP })
    .sign(keyFor(secret));
}

/**
 * A download link's token (§10.5): the user and client a `voicemails.audio` or `recordings.audio`
 * tool call ran as, `aud` the one REST path it opens. Its `typ` sets it apart from an access token
 * (RFC 8725 §3.11), so it never authenticates as one.
 */
export type DownloadPayload = {
  sub: string;
  cid: string | null;
  aud: string;
  iat: number;
  exp: number;
};

const DownloadPayloadSchema = z.object({
  sub: z.string(),
  cid: z.string().nullable(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number()
});

const DOWNLOAD_TYP = 'download+jwt';

/** Encodes `payload` as an HS256 download-link token signed with `secret`. */
export function encodeDownloadToken(
  secret: string,
  payload: DownloadPayload
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG, typ: DOWNLOAD_TYP })
    .sign(keyFor(secret));
}

/** The payload of `token` once its signature, algorithm, `typ`, expiry against `nowS` and, given
 *  an `audience`, its `aud` hold; `null` for any token that fails. */
async function verifiedPayload<T>(
  secret: string,
  token: string,
  nowS: number,
  check: { typ: string; audience?: string; schema: z.ZodType<T> }
): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, keyFor(secret), {
      algorithms: [JWT_ALG],
      typ: check.typ,
      audience: check.audience,
      currentDate: new Date(nowS * MS_PER_SECOND)
    });
    const parsed = check.schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      return null;
    }
    throw error;
  }
}

/**
 * Verifies an access token's signature, algorithm and expiry against `nowS`, and, given an
 * `audience`, that the token was issued for it (RFC 8707: the MCP endpoint passes its own
 * resource, §10.5). Returns its claims, or `null` for any token that fails.
 */
export async function verifyAccessToken(
  secret: string,
  token: string,
  nowS: number,
  audience?: string
): Promise<AccessClaims | null> {
  const payload = await verifiedPayload(secret, token, nowS, {
    typ: JWT_TYP,
    audience,
    schema: AccessPayloadSchema
  });
  return payload && { sub: payload.sub, role: payload.role, cid: payload.cid };
}

/** The user and client of download-link token `token`, verified like an access token and opening
 *  `path` alone; `null` for any token that fails. */
export async function verifyDownloadToken(
  secret: string,
  token: string,
  nowS: number,
  path: string
): Promise<{ sub: string; cid: string | null } | null> {
  const payload = await verifiedPayload(secret, token, nowS, {
    typ: DOWNLOAD_TYP,
    audience: path,
    schema: DownloadPayloadSchema
  });
  return payload && { sub: payload.sub, cid: payload.cid };
}
