import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { MS_PER_SECOND, type UserRole } from '@zamfono/shared';

import { mcpResourceUri } from './resource.js';

// §5.2: an access token lives 15 minutes; `api` is the only party that ever verifies it, so
// there is no JWKS and no asymmetric key pair.
export const ACCESS_TOKEN_TTL_S = 900;
const JWT_ALG = 'HS256';
const JWT_TYP = 'JWT';

/** The identity an access token carries: the user, their role and the OAuth client, if any. */
export type AccessClaims = { sub: string; role: UserRole; cid: string | null };

/** Type guard for the RBAC roles a JWT `role` claim (or a `users.role` column) may hold. */
export function isRole(value: unknown): value is UserRole {
  return value === 'owner' || value === 'admin' || value === 'user';
}

/** The claims as signed: `aud` is the RFC 8707 resource the token was issued for (`resource.ts`). */
const AccessPayloadSchema = z.object({
  sub: z.string(),
  role: z.custom<UserRole>(isRole),
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
 * order.
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
 * Signs an HS256 access token issued by `origin`, the stack's own (`originFromEnv()`), for its
 * MCP server, the one resource it issues tokens for (`resource.ts`): `exp` is `nowS + 900` (§5.2,
 * §6.3).
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

/**
 * A link's token (§10.5): the user and client a file tool call ran as, `aud` the one REST path it
 * opens. Its `typ`, `download+jwt` or `upload+jwt`, sets it apart from an access token and from the
 * other kind of link (RFC 8725 §3.11), so it never authenticates as either.
 */
export type LinkPayload = {
  sub: string;
  cid: string | null;
  aud: string;
  iat: number;
  exp: number;
};

const LinkPayloadSchema = z.object({
  sub: z.string(),
  cid: z.string().nullable(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number()
});

/** What a link does with its path: `download` the file a `GET` answers, `upload` one it takes. */
export type LinkKind = 'download' | 'upload';

/** Encodes `payload` as an HS256 link token of `kind` signed with `secret`. */
export function encodeLinkToken(
  secret: string,
  kind: LinkKind,
  payload: LinkPayload
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG, typ: `${kind}+jwt` })
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

/** The user and client of link token `token` of `kind`, verified like an access token and opening
 *  `path` alone; `null` for any token that fails. */
export async function verifyLinkToken(
  secret: string,
  kind: LinkKind,
  token: string,
  nowS: number,
  path: string
): Promise<{ sub: string; cid: string | null } | null> {
  const payload = await verifiedPayload(secret, token, nowS, {
    typ: `${kind}+jwt`,
    audience: path,
    schema: LinkPayloadSchema
  });
  return payload && { sub: payload.sub, cid: payload.cid };
}
