/**
 * A static bearer token, as `api`'s `/metrics` checks `METRICS_TOKEN` (§7) and `api`'s and
 * `core`'s `/internal/*` check `INTERNAL_TOKEN` (§3.1).
 */
import { timingSafeEqual } from 'node:crypto';

export const BEARER_PREFIX = 'Bearer ';

/** Whether `authorization` is exactly `Bearer <token>`, compared in constant time: a static
 *  shared secret, so a byte-by-byte comparison would leak it through timing. Never true for an
 *  empty `token`. */
export function isValidBearer(
  authorization: string | null | undefined,
  token: string
): boolean {
  const expected = Buffer.from(`${BEARER_PREFIX}${token}`);
  const actual = Buffer.from(authorization ?? '');
  return (
    token !== '' &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

/** The `Authorization` header a request to `api`'s or `core`'s `/internal/*` carries (§3.1). */
export function internalAuthorization(token: string): {
  authorization: string;
} {
  return { authorization: `${BEARER_PREFIX}${token}` };
}
