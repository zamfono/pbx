import { isHttpError } from '@sveltejs/kit';
import pino from 'pino';

import {
  HTTP_CONTENT_TOO_LARGE,
  HTTP_INTERNAL_SERVER_ERROR,
  isRecord,
  PROBLEM_CONTENT_TYPE
} from '@zamfono/shared';

import { OpError } from './ops/types.js';
import { MAX_BODY_BYTES } from './requestBody.js';

const logger = pino({ name: 'rest' });

/**
 * The shares of the request body limit a refusal's issue list may fill, so that no refusal is
 * larger than a request may be (§10.3, conventions): an MCP refusal carries the list once as
 * `structuredContent` and once serialised in its text block, whose escaping inside the JSON-RPC
 * response at most doubles it, three shares; the fourth is room for the rest of the refusal.
 */
const REFUSAL_SHARES = 4;

/** The most bytes of JSON a refusal's issue list takes: a quarter of the request body limit. */
export const ISSUES_BUDGET_BYTES = MAX_BODY_BYTES / REFUSAL_SHARES;

/**
 * `issues` from the first, as many as fit `ISSUES_BUDGET_BYTES` serialised as a JSON array, and
 * how many were left out. A body of 512 KiB can draw some 170,000 zod issues, 23 MB of JSON.
 */
export function boundedIssues<T>(issues: readonly T[]): {
  kept: T[];
  omitted: number;
} {
  let size = 2;
  let kept = 0;
  for (const issue of issues) {
    size += Buffer.byteLength(JSON.stringify(issue)) + Number(kept > 0);
    if (size > ISSUES_BUDGET_BYTES) {
      break;
    }
    kept++;
  }
  return { kept: issues.slice(0, kept), omitted: issues.length - kept };
}

/**
 * `detail`'s own keys as RFC 9457 extension members, or nothing for `undefined` — `OpError`'s own
 * `detail` is already a named-field object (`{ confirmationRequired, question }`,
 * `{ references }`) or a zod issue array (§10.3). RFC 9457 §3.1 defines `detail` as a
 * human-readable string, so an array (the zod issues) is carried under the `errors` extension
 * member instead, never under `detail` itself, bounded by `boundedIssues`, with `errorsOmitted`
 * counting the issues left out where there are any.
 */
export function extensionMembers(detail: unknown): Record<string, unknown> {
  if (detail === undefined) {
    return {};
  }
  if (Array.isArray(detail)) {
    const { kept, omitted } = boundedIssues(detail);
    return omitted > 0
      ? { errors: kept, errorsOmitted: omitted }
      : { errors: kept };
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
