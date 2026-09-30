/**
 * A thin HTTP client for `core`'s internal API (§3, §3.1; `@zamfono/shared`'s `internalApi.ts`):
 * config-reload triggers, live state, call actions and MWI, reached over the Docker `internal`
 * network with no authentication, since that network is the trust boundary.
 */
import process from 'node:process';

import type {
  CoreHealth,
  CoreVersionResponse,
  HangupRequest,
  MwiMailbox,
  OriginateRequest,
  PickupRequest,
  ReloadKind,
  StateResponse,
  TransferRequest
} from '@zamfono/shared';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const DEFAULT_CORE_URL = 'http://core:3000';
// `/healthz`, `/metrics` and `system.info` answer within this even while `core` hangs (§6.3
// "Health", §7, §10.3), and a hung `core` holds up no re-registration check (§10.4).
const CORE_HEALTH_TIMEOUT_MS = 3000;

export type OriginateOutcome =
  { callId: string } | { error: 'noRegisteredDevice' };

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

export type CoreClient = {
  configChanged(kinds: ReloadKind[]): Promise<void>;
  state(): Promise<StateResponse>;
  originate(req: OriginateRequest): Promise<OriginateOutcome>;
  transfer(callId: string, req: TransferRequest): Promise<void>;
  pickup(callId: string, req: PickupRequest): Promise<void>;
  hangup(callId: string, req: HangupRequest): Promise<void>;
  mwi(mailbox: MwiMailbox): Promise<void>;
};

/** `CORE_URL` (§6.3, default `http://core:3000`), read at call time so tests can override it. */
export function coreUrlFromEnv(): string {
  return process.env.CORE_URL ?? DEFAULT_CORE_URL;
}

async function postJson(
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
async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

/** Throws `CoreRequestError` for a non-2xx `response`; callers get a rejected promise instead of silently treating a failed reload or call action as having succeeded. */
async function throwIfNotOk(response: Response, url: string): Promise<void> {
  if (!response.ok) {
    throw new CoreRequestError(
      url,
      response.status,
      await readJsonBody(response)
    );
  }
}

/** POSTs `body` to `url` and throws on a non-2xx response. */
async function postJsonChecked(
  fetchFn: typeof fetch,
  url: string,
  body: unknown
): Promise<void> {
  const response = await postJson(fetchFn, url, body);
  await throwIfNotOk(response, url);
}

/** Whether `body` is the problem whose `detail` names the `noRegisteredDevice` cause of a 409
 * (§10.2 "Click-to-dial", `internalApi.ts`). */
function namesNoRegisteredDevice(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  return (body as { detail?: unknown }).detail === 'noRegisteredDevice';
}

/** The statuses `core` refuses a call action with (`calls/actions.ts`'s `ActionError`): 404 for a
 * call it holds no live state for, 409 for one in the wrong state or a picker without a device. */
const REFUSAL_STATUSES = [HTTP_NOT_FOUND, HTTP_CONFLICT] as const;

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

/**
 * The version `core` reports it runs (§7 "Version"), since when, and since when its Asterisk
 * runs, from its internal API at `baseUrl`. Rejects when `core` does not answer within
 * `CORE_HEALTH_TIMEOUT_MS`, as `fetchCoreHealth` does.
 */
export async function fetchCoreVersion(
  baseUrl: string = coreUrlFromEnv(),
  fetchFn: typeof fetch = fetch
): Promise<CoreVersionResponse> {
  const url = `${baseUrl}/internal/version`;
  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(CORE_HEALTH_TIMEOUT_MS)
  });
  await throwIfNotOk(response, url);
  return (await response.json()) as CoreVersionResponse;
}

/**
 * `core`'s own `GET /healthz` (`CoreHealth`), for `api`'s `/healthz` and `/metrics`: its body
 * whatever the status, since a 503 still says which of the database and ARI is down. Rejects
 * when `core` does not answer within `CORE_HEALTH_TIMEOUT_MS` or answers no such body.
 */
export async function fetchCoreHealth(
  baseUrl: string = coreUrlFromEnv(),
  fetchFn: typeof fetch = fetch
): Promise<CoreHealth> {
  const response = await fetchFn(`${baseUrl}/healthz`, {
    signal: AbortSignal.timeout(CORE_HEALTH_TIMEOUT_MS)
  });
  return (await response.json()) as CoreHealth;
}

/** `core`'s internal API at `baseUrl` (default `coreUrlFromEnv()`). */
export function createCoreClient(
  baseUrl: string = coreUrlFromEnv(),
  fetchFn: typeof fetch = fetch
): CoreClient {
  return {
    async configChanged(kinds) {
      await postJsonChecked(fetchFn, `${baseUrl}/internal/configChanged`, {
        reload: kinds
      });
    },
    async state() {
      const url = `${baseUrl}/internal/state`;
      const response = await fetchFn(url);
      await throwIfNotOk(response, url);
      return (await response.json()) as StateResponse;
    },
    async originate(req) {
      const url = `${baseUrl}/internal/calls`;
      const response = await postJson(fetchFn, url, req);
      const body: unknown = await readJsonBody(response);
      if (response.status === HTTP_CONFLICT && namesNoRegisteredDevice(body)) {
        return { error: 'noRegisteredDevice' };
      }
      if (!response.ok) {
        throw new CoreRequestError(url, response.status, body);
      }
      return body as { callId: string };
    },
    async transfer(callId, req) {
      await postJsonChecked(
        fetchFn,
        `${baseUrl}/internal/calls/${encodeURIComponent(callId)}/transfer`,
        req
      );
    },
    async pickup(callId, req) {
      await postJsonChecked(
        fetchFn,
        `${baseUrl}/internal/calls/${encodeURIComponent(callId)}/pickup`,
        req
      );
    },
    async hangup(callId, req) {
      await postJsonChecked(
        fetchFn,
        `${baseUrl}/internal/calls/${encodeURIComponent(callId)}/hangup`,
        req
      );
    },
    async mwi(mailbox) {
      // Not `encodeURIComponent`-escaped: `mailbox` is `user:<id>` or `ringGroup:<id>` by
      // construction (`MwiMailbox`), and escaping its routing colon to `%3A` would change the
      // path segment core matches against.
      await postJsonChecked(
        fetchFn,
        `${baseUrl}/internal/mwi/${mailbox}`,
        undefined
      );
    }
  };
}
