/** The `INTERNAL_TOKEN` a test's internal server takes (§3.1), and `fetch` with it. */
import { internalAuthorization } from '@zamfono/shared';

export const TEST_INTERNAL_TOKEN = 'test-internal-token';

/** `fetch` with `TEST_INTERNAL_TOKEN` as the bearer token, as `api` asks `core`. */
export function internalFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(
    'authorization',
    internalAuthorization(TEST_INTERNAL_TOKEN).authorization
  );
  return fetch(url, { ...init, headers });
}
