import pino from 'pino';

import { HTTP_INTERNAL_SERVER_ERROR } from '@zamfono/shared';

import { OpError } from './ops/types.js';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
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
  if (typeof detail === 'object' && detail !== null) {
    return detail as Record<string, unknown>;
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
 * Converts an error thrown by the runner or an operation's `run` into its problem response: an
 * `OpError` answers with its own status, title and detail; anything else answers 500 without
 * detail, so an operation's internal failure never leaks internals over the wire. That failure is
 * logged here instead, since the opaque response is the only other trace it leaves.
 */
export function problemFromError(error: unknown): Response {
  if (error instanceof OpError) {
    return problem(error.status, error.title, error.detail);
  }
  logger.error({ err: error }, 'rest: operation failed');
  return problem(HTTP_INTERNAL_SERVER_ERROR, 'internal server error');
}
