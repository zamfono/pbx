import { createHmac, timingSafeEqual } from 'node:crypto';
import process from 'node:process';

import type { Role } from '../ops/types.js';

// §5.2: an access token lives 15 minutes; `api` is the only party that ever verifies it, so
// there is no JWKS and no asymmetric key pair.
export const ACCESS_TOKEN_TTL_S = 900;
const JWT_ALG = 'HS256';
const JWT_TYP = 'JWT';
const JWT_SEGMENT_COUNT = 3;

/** The identity an access token carries: the user, their role and the OAuth client, if any. */
export type AccessClaims = { sub: string; role: Role; cid: string | null };

/**
 * The claims as signed: `aud` is the RFC 8707 resource the token was issued for (`resource.ts`),
 * absent only from a token signed before audiences were, which the REST API still accepts.
 */
type AccessPayload = AccessClaims & {
  iss: string;
  aud?: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(secret: string, signingInput: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/** `JSON.parse(text)`, or `undefined` when `text` is not valid JSON. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Type guard for the RBAC roles a JWT `role` claim (or a `users.role` column) may hold. */
export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'user';
}

/** Parses and shape-checks a payload segment; `null` on malformed JSON or a missing claim. */
function parsePayload(encoded: string): AccessPayload | null {
  const decoded = tryParseJson(base64UrlDecode(encoded));
  if (typeof decoded !== 'object' || decoded === null) {
    return null;
  }
  const { sub, role, cid, iss, aud, iat, exp } = decoded as Record<
    string,
    unknown
  >;
  if (
    typeof sub !== 'string' ||
    !isRole(role) ||
    (typeof cid !== 'string' && cid !== null) ||
    typeof iss !== 'string' ||
    (typeof aud !== 'string' && aud !== undefined) ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    return null;
  }
  return { sub, role, cid, iss, aud, iat, exp };
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
  const header = base64UrlEncode(
    JSON.stringify({ alg: JWT_ALG, typ: JWT_TYP })
  );
  const payload: AccessPayload = {
    ...claims,
    iss: process.env.ORIGIN ?? '',
    aud: audience,
    iat: nowS,
    exp: nowS + ACCESS_TOKEN_TTL_S
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${sign(secret, signingInput)}`;
}

/**
 * Verifies an access token's signature (constant-time), header and expiry against `nowS`, and,
 * given an `audience`, that the token was issued for it (RFC 8707: the MCP endpoint passes its
 * own resource, §10.5). Returns its claims, or `null` on any failure.
 */
export function verifyAccessToken(
  secret: string,
  token: string,
  nowS: number,
  audience?: string
): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== JWT_SEGMENT_COUNT) {
    return null;
  }
  const [header, body, signature] = parts;
  // The length check above guarantees all three segments are present.
  if (header === undefined || body === undefined || signature === undefined) {
    return null;
  }
  const headerJson = tryParseJson(base64UrlDecode(header));
  const alg =
    typeof headerJson === 'object' && headerJson !== null
      ? (headerJson as Record<string, unknown>).alg
      : null;
  if (alg !== JWT_ALG) {
    return null;
  }
  const expected = Buffer.from(sign(secret, `${header}.${body}`));
  const provided = Buffer.from(signature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  const payload = parsePayload(body);
  if (
    !payload ||
    payload.exp <= nowS ||
    (audience !== undefined && payload.aud !== audience)
  ) {
    return null;
  }
  return { sub: payload.sub, role: payload.role, cid: payload.cid };
}
