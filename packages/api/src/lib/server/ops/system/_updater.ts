import process from 'node:process';

/**
 * `api`'s side of the updater service (§6.3 "Updates"): the one process that holds
 * `UPDATER_TOKEN` besides the updater itself, over the stack's internal network.
 */
export type UpdateState = {
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  from?: string;
  to?: string;
  /** Who asked for the run, `by` naming the owner of a manual one; absent from an older record. */
  trigger?: 'manual' | 'automatic' | 'host';
  by?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

/** The updater's `GET /status`, verbatim. */
export type UpdaterStatus = {
  current: string | null;
  latest: { version: string; url: string; publishedAt: string } | null;
  latestError?: string;
  updatable: boolean;
  breaking: boolean;
  last: UpdateState;
  unavailable?: string;
};

/** A refusal the updater answered with, its status and message passed on to the caller. */
export class UpdaterRefusal extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Who asks the updater for a run, which it records with the run. */
export type RunRequester = { trigger: 'manual' | 'automatic'; by: string };

export type UpdaterClient = {
  status: () => Promise<UpdaterStatus>;
  /** `POST /update`: the latest release, or `version`; resolves once the updater has begun. */
  update: (
    version: string | undefined,
    requester?: RunRequester
  ) => Promise<UpdateState>;
};

const DEFAULT_URL = 'http://updater:8080';
const TIMEOUT_MS = 10_000;

async function call<T>(
  path: string,
  init: RequestInit & { token: string }
): Promise<T> {
  const base = process.env.UPDATER_URL ?? DEFAULT_URL;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${init.token}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  if (!response.ok) {
    throw new UpdaterRefusal(
      response.status,
      typeof body.error === 'string'
        ? body.error
        : `the updater answered ${response.status}`
    );
  }
  return body as T;
}

/** The client for `UPDATER_TOKEN`, or `undefined` while `.env` sets none. */
export function updaterFromEnv(): UpdaterClient | undefined {
  const token = process.env.UPDATER_TOKEN ?? '';
  if (token === '') {
    return undefined;
  }
  return {
    status: async () => call<UpdaterStatus>('/status', { token }),
    update: async (version, requester) =>
      call<UpdateState>('/update', {
        token,
        method: 'POST',
        body: JSON.stringify({
          ...(version === undefined ? {} : { version }),
          ...requester
        })
      })
  };
}

// One mutable module slot, as `info.ts` holds its core lookup: a test installs a fake.
const clientHolder: { current: (() => UpdaterClient | undefined) | undefined } =
  { current: undefined };

export function setUpdaterClient(
  factory: (() => UpdaterClient | undefined) | undefined
): void {
  clientHolder.current = factory;
}

export function updaterClient(): UpdaterClient | undefined {
  return (clientHolder.current ?? updaterFromEnv)();
}
