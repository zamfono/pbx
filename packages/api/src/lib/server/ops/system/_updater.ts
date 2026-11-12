/**
 * `api`'s side of the updater service (§6.3 "Updates"): the one process that holds
 * `UPDATER_TOKEN` besides the updater itself, over the stack's internal network.
 */
import * as env from '$app/env/private';

import {
  isRecord,
  type HostStatus,
  type UpdateRequester,
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
  /** `POST /update`: the latest release, or `version`, a breaking one only with the owner's
   * `breaking`; resolves once the updater has begun. */
  update: (
    version: string | undefined,
    requester?: UpdateRequester
  ) => Promise<UpdateState>;
};

// The updater answers within 9 s, the host agent's take and answer included
// (`packages/updater`'s REQUEST_BUDGET_MS), so nothing it asks of the host happens after this
// gives up.
const TIMEOUT_MS = 10_000;
const MAX_BY_BYTES = 200;

/**
 * An owner's name as the updater and the host agent take it for a run's record: no control
 * characters, at most 200 bytes of UTF-8, cut at a character.
 */
export function ownerName(name: string): string {
  let out = '';
  for (const char of name.replace(/\p{Cc}/gu, ' ')) {
    if (Buffer.byteLength(out + char) > MAX_BY_BYTES) {
      break;
    }
    out += char;
  }
  return out.trim() || 'an owner';
}

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
  // The commit api was built from, which an edge stack's newest build is newer than when they
  // differ (§6.3 "Updates").
  const revision = `?revision=${encodeURIComponent(env.ZAMFONO_REVISION ?? '')}`;
  return {
    status: async fresh =>
      fresh === true
        ? call<UpdaterStatus>(`/check${revision}`, { token, method: 'POST' })
        : call<UpdaterStatus>(`/status${revision}`, { token }),
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

/** The updater's host routes (§6.3 "Host control"). */
export type HostClient = {
  /** `GET /host`: what the host agent last reported. */
  read: () => Promise<HostStatus>;
  /** `POST /host/check`: has the host agent read the host now, and answers with its report. */
  check: () => Promise<HostStatus>;
  /** `POST /host/updates`: Zamfono's unattended upgrades on or off; resolves once the host
   * agent took the request, which it carries out after. */
  setUpdates: (enabled: boolean) => Promise<void>;
  /** `POST /host/reboot`: resolves once the host agent took the request. */
  reboot: () => Promise<void>;
};

/**
 * The host client, or `undefined` unless `.env` sets `HOST_CONTROL=true` and an `UPDATER_TOKEN`:
 * without them nothing of the host is shown or offered.
 */
export function hostClient(): HostClient | undefined {
  const token = env.UPDATER_TOKEN;
  if (!env.HOST_CONTROL || token === undefined) {
    return undefined;
  }
  return {
    read: async () => call<HostStatus>('/host', { token }),
    check: async () =>
      call<HostStatus>('/host/check', { token, method: 'POST' }),
    setUpdates: async enabled => {
      await call('/host/updates', {
        token,
        method: 'POST',
        body: JSON.stringify({ enabled })
      });
    },
    reboot: async () => {
      await call('/host/reboot', { token, method: 'POST' });
    }
  };
}
