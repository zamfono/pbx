/**
 * The transport under `coreClient.ts`: JSON over HTTP to `core`'s internal API, every failure as
 * the problem an operation answers with (§10.3): `core`'s refusal keeps its status and reason,
 * anything else, `core` not answering included, is a 503.
 */

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNPROCESSABLE_CONTENT
} from '@zamfono/shared';

import { errorMessage } from './errors.js';
import { tryReadJson } from './json.js';
import { OpError } from './ops/types.js';

/** The statuses `core` refuses a call action with (`calls/actionError.ts`'s `ActionError`): 404
 * for a call it holds no live state for, 409 for one in the wrong state or a picker without a
 * device, 422 for a target it cannot act on (a voicemail transfer to no mailbox, a party added
 * or consulted on a target nobody answers on). */
const REFUSAL_STATUSES = [
  HTTP_NOT_FOUND,
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE_CONTENT
] as const;

/**
 * The problem for `core`'s non-2xx answer to `url`: a refusal, one of `REFUSAL_STATUSES` with an
 * RFC 9457 body whose `detail` is the reason (`internal/actionRoutes.ts`), keeps its status,
 * `title` and `detail`; any other answer, a malformed body included, is a 503.
 */
function failure(url: string, status: number, body: unknown): OpError {
  const refusal = REFUSAL_STATUSES.find(candidate => candidate === status);
  const problem = body as { title?: unknown; detail?: unknown } | undefined;
  if (
    refusal !== undefined &&
    typeof problem?.title === 'string' &&
    typeof problem.detail === 'string'
  ) {
    return new OpError(refusal, problem.title, problem.detail);
  }
  return new OpError(
    HTTP_SERVICE_UNAVAILABLE,
    `core request to ${url} failed with status ${status}`
  );
}

/** Every request to `core`: its 2xx response, else the problem `failure` makes of it, or a 503
 * when `core` does not answer. */
export async function coreFetch(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    throw new OpError(
      HTTP_SERVICE_UNAVAILABLE,
      `core did not answer ${url}: ${errorMessage(error)}`
    );
  }
  if (!response.ok) {
    throw failure(url, response.status, await tryReadJson(response));
  }
  return response;
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

/** POSTs `body` to `url`. */
export async function postJsonChecked(
  fetchFn: typeof fetch,
  url: string,
  body: unknown
): Promise<void> {
  await coreFetch(fetchFn, url, postInit(body));
}

/** POSTs `body` to `url` and answers its JSON body. */
export async function postJsonForBody(
  fetchFn: typeof fetch,
  url: string,
  body: unknown
): Promise<unknown> {
  return tryReadJson(await coreFetch(fetchFn, url, postInit(body)));
}
