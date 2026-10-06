import { isHttpError } from '@sveltejs/kit';
import pino from 'pino';

import {
  HTTP_CONTENT_TOO_LARGE,
  HTTP_INTERNAL_SERVER_ERROR,
  isRecord,
  PROBLEM_CONTENT_TYPE
} from '@zamfono/shared';

import { OpError } from './ops/types.js';

const logger = pino({ name: 'rest' });

/**
 * `detail`'s own keys as RFC 9457 extension members, or nothing for `undefined` — `OpError`'s own
 * `detail` is already a named-field object (`{ confirmationRequired, question }`,
 * `{ references }`) or a zod issue array (§10.3). RFC 9457 §3.1 defines `detail` as a
 * human-readable string, so an array (the zod issues) is carried under the `errors` extension
 * member instead, never under `detail` itself.
 */
export function extensionMembers(detail: unknown): Record<string, unknown> {
  if (detail === undefined) {
    return {};
  }
  if (Array.isArray(detail)) {
    return { errors: detail };
  }
  if (isRecord(detail)) {
    return detail;
  }
  return { detail };
}

/** An RFC 9457 `application/problem+json` response (§10.3 "Conventions"); `headers` adds wire headers such as `Retry-After` on a 429. */
export function problem(
  status: number,
  title: string,
  detail?: unknown,
  headers?: Record<string, string>
): Response {
  const body = {
    type: 'about:blank',
    title,
    status,
    ...extensionMembers(detail)
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, ...headers }
  });
}

/**
 * Whether `error` is SvelteKit's refusal of a request body over adapter-node's `BODY_SIZE_LIMIT`,
 * which reading the body rejects with: an `Error` with `status` 413 (SvelteKit's `SvelteKitError`,
 * which it does not export).
 */
function isBodyTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    error.status === HTTP_CONTENT_TOO_LARGE
  );
}

/**
 * Converts an error thrown by the runner, an operation's `run` or reading the request body into
 * its problem response: an `OpError` answers with its own status, title and detail, a body over
 * the size limit with 413; anything else answers 500 without
 * detail, so an operation's internal failure never leaks internals over the wire. That failure is
 * logged here instead, since the opaque response is the only other trace it leaves.
 */
export function problemFromError(error: unknown): Response {
  if (error instanceof OpError) {
    return problem(error.status, error.title, error.detail, error.headers);
  }
  if (isHttpError(error)) {
    return problem(error.status, error.body.message);
  }
  if (isBodyTooLarge(error)) {
    return problem(HTTP_CONTENT_TOO_LARGE, 'request body too large');
  }
  logger.error({ err: error }, 'rest: operation failed');
  return problem(HTTP_INTERNAL_SERVER_ERROR, 'internal server error');
}
