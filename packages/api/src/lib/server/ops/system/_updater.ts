/**
 * `api`'s side of the updater service (§6.3 "Updates"): the one process that holds
 * `UPDATER_TOKEN` besides the updater itself, over the stack's internal network.
 */
import * as env from '$app/env/private';

import {
  isRecord,
  type RunRequester,
  type UpdaterStatus,
  type UpdateState
} from '@zamfono/shared';

import { tryReadJson } from '#lib/server/json.js';

/** A refusal the updater answered with, its status, message and `Retry-After` in seconds passed
 * on to the caller. */
export class UpdaterRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS?: number
  ) {
    super(message);
  }
}

export type UpdaterClient = {
  /** `GET /status`, or with `fresh` `POST /check`, which asks GitHub now. */
  status: (fresh?: boolean) => Promise<UpdaterStatus>;
  /** `POST /update`: the latest release, or `version`; resolves once the updater has begun. */
  update: (
    version: string | undefined,
    requester?: RunRequester
  ) => Promise<UpdateState>;
};

const TIMEOUT_MS = 10_000;

async function call<T>(
  path: string,
  init: RequestInit & { token: string }
): Promise<T> {
  const response = await fetch(`${env.UPDATER_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${init.token}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await tryReadJson(response);
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    throw new UpdaterRefusal(
      response.status,
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `the updater answered ${response.status}`,
      retryAfter === null ? undefined : Number(retryAfter)
    );
  }
  return body as T;
}

/** The client for `UPDATER_TOKEN`, or `undefined` while `.env` sets none. */
export function updaterClient(): UpdaterClient | undefined {
  const token = env.UPDATER_TOKEN;
  if (token === undefined) {
    return undefined;
  }
  return {
    status: async fresh =>
      fresh === true
        ? call<UpdaterStatus>('/check', { token, method: 'POST' })
        : call<UpdaterStatus>('/status', { token }),
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
