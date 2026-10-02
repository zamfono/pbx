/**
 * The transport under `coreClient.ts`: JSON over HTTP to `core`'s internal API, a non-2xx answer
 * as a `CoreRequestError`, and the call-action refusals read back out of one.
 */

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

/** A non-2xx response from `core`'s internal API, carrying the status and, if parseable, the body. */
export class CoreRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(url: string, status: number, body: unknown) {
    super(`core request to ${url} failed with status ${status}`);
    this.name = 'CoreRequestError';
    this.status = status;
    this.body = body;
  }
}

export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  body: unknown
): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/** `response`'s body, parsed as JSON, or `undefined` when it is empty or not JSON. */
export async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

/** Throws `CoreRequestError` for a non-2xx `response`; callers get a rejected promise instead of silently treating a failed reload or call action as having succeeded. */
export async function throwIfNotOk(
  response: Response,
  url: string
): Promise<void> {
  if (!response.ok) {
    throw new CoreRequestError(
      url,
      response.status,
      await readJsonBody(response)
    );
  }
}

/** POSTs `body` to `url` and throws on a non-2xx response. */
export async function postJsonChecked(
  fetchFn: typeof fetch,
  url: string,
  body: unknown
): Promise<void> {
  const response = await postJson(fetchFn, url, body);
  await throwIfNotOk(response, url);
}

/** POSTs `body` to `url` and answers its JSON body, throwing on a non-2xx response. */
export async function postJsonForBody(
  fetchFn: typeof fetch,
  url: string,
  body: unknown
): Promise<unknown> {
  const response = await postJson(fetchFn, url, body);
  const parsed = await readJsonBody(response);
  if (!response.ok) {
    throw new CoreRequestError(url, response.status, parsed);
  }
  return parsed;
}

/** The statuses `core` refuses a call action with (`calls/actionError.ts`'s `ActionError`): 404
 * for a call it holds no live state for, 409 for one in the wrong state or a picker without a
 * device, 422 for a target it cannot act on (a voicemail transfer to no mailbox, a party added
 * or consulted on a target nobody answers on). */
const REFUSAL_STATUSES = [
  HTTP_NOT_FOUND,
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE
] as const;

/** A call action `core` refused: its status and the RFC 9457 problem's `title` and `detail`. */
export type CoreRefusal = {
  status: (typeof REFUSAL_STATUSES)[number];
  title: string;
  detail: string;
};

/**
 * The refusal `error` carries, when it is `core` answering a call action with its RFC 9457
 * problem, whose `detail` is the reason (`internal/actionRoutes.ts`); `null` for any other
 * failure, a malformed body or `core` being unreachable included, which stays a 500.
 */
export function coreRefusal(error: unknown): CoreRefusal | null {
  if (!(error instanceof CoreRequestError)) {
    return null;
  }
  const status = REFUSAL_STATUSES.find(candidate => candidate === error.status);
  const body = error.body as { title?: unknown; detail?: unknown } | undefined;
  if (
    status === undefined ||
    typeof body?.title !== 'string' ||
    typeof body.detail !== 'string'
  ) {
    return null;
  }
  return { status, title: body.title, detail: body.detail };
}
