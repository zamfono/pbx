/**
 * What the authorization server's JSON endpoints (§5.2) share: their dependency shapes, the
 * RFC 6749 vocabulary the metadata document advertises, the error body and the form reader.
 */
import type { Db } from '@zamfono/shared';

// RFC 6749 grant types this authorization server accepts (§5.2).
export const GRANT_AUTHORIZATION_CODE = 'authorization_code';
export const GRANT_REFRESH_TOKEN = 'refresh_token';
/** Registered clients are public clients: PKCE, no secret (§5.2). */
export const NO_AUTH_METHOD = 'none';

export const STATUS_OK = 200;
export const STATUS_CREATED = 201;
export const STATUS_BAD_REQUEST = 400;

/** What every oauth request function needs beyond the request itself. */
export type BaseDeps = {
  db: Db;
  /** The current instant as an ISO-8601 string, for the rows this call writes. */
  now: () => string;
};

/** An RFC 6749 §5.2 error response: `{ error }`, never cached. */
export function oauthError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache'
    }
  });
}

/** The request's `application/x-www-form-urlencoded` body; file fields are dropped. */
export async function readForm(req: Request): Promise<URLSearchParams> {
  const formData = await req.formData();
  const params = new URLSearchParams();
  for (const [key, value] of formData) {
    if (typeof value === 'string') {
      params.append(key, value);
    }
  }
  return params;
}
