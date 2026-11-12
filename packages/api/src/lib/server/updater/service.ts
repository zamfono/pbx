import {
  HTTP_CONFLICT,
  HTTP_SERVICE_UNAVAILABLE,
  type UpdaterStatus,
  type UpdateState
} from '@zamfono/shared';

import { REQUEST_BUDGET_MS, type Agent } from './agent.js';
import { passOnRefusal, UpdaterRefusal } from './errors.js';
import { createHost, type Host } from './host.js';
import { recordSince } from './record.js';
import { GitHubRateLimited, type Releases } from './releases.js';
import type { UpdateVerdict } from './stack.js';
import { describeStatus, unavailable } from './status.js';
import {
  breakingOf,
  edgeTarget,
  PINS_NO_RELEASE,
  refusal,
  releaseTarget,
  requesterOf
} from './updateRequest.js';
import { EDGE, formatStackVersion, type StackVersion } from './version.js';

/**
 * `api`'s updater (§6.3 "Updates"): what the stack runs and the newest release GitHub names, and
 * the update, reboot or upgrades switch it leaves the host agent as a request (`agent.ts`). Its
 * refusals are `UpdaterRefusal`s with the status the operations layer answers with.
 */
const MS_PER_SECOND = 1000;
/** How long after its call `update` answers at the latest, the run's record included. */
const RESPONSE_BUDGET_MS = 9000;

export type UpdaterDeps = {
  releases: Releases;
  /** The version the stack directory runs, as the host agent last reported it. */
  currentVersion: () => Promise<StackVersion | undefined>;
  /** The verdict on an update to a release, by RELEASING.md's policy (stack.ts). */
  checkUpdate: (version: string) => Promise<UpdateVerdict>;
  agent: Agent;
};

export type Updater = {
  /** What the stack runs, the latest release, and whether it can update; `fresh` asks GitHub
   * now, at most once a minute. `revision` is the commit `api` was built from. */
  status: (fresh: boolean, revision?: string) => Promise<UpdaterStatus>;
  /** Hands the update `body` asks for (`{ version?, trigger, by?, breaking? }`) to the host
   * agent; resolves with the run's record once it began. */
  update: (body: unknown) => Promise<UpdateState>;
  host: Host;
};

/** A spent GitHub rate limit as a 503 with when to retry; anything else unchanged. */
async function rateLimited<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GitHubRateLimited) {
      const seconds = Math.ceil((error.retryAt - Date.now()) / MS_PER_SECOND);
      throw new UpdaterRefusal(
        HTTP_SERVICE_UNAVAILABLE,
        error.message,
        Math.max(1, seconds)
      );
    }
    throw error;
  }
}

async function update(
  deps: UpdaterDeps,
  body: unknown,
  started: number
): Promise<UpdateState> {
  const reason = await unavailable(deps);
  if (reason !== undefined) {
    throw new UpdaterRefusal(HTTP_SERVICE_UNAVAILABLE, reason);
  }
  if (deps.agent.state().state === 'running') {
    throw new UpdaterRefusal(HTTP_CONFLICT, 'an update is already running');
  }
  const current = await deps.currentVersion();
  if (current === undefined) {
    throw new UpdaterRefusal(HTTP_CONFLICT, PINS_NO_RELEASE);
  }
  const requester = requesterOf(body);
  const breaking = breakingOf(body, requester);
  const asked = (body as { version?: unknown }).version;
  const to =
    current === EDGE ? edgeTarget(asked) : await releaseTarget(deps, asked);
  const verdict = await deps.checkUpdate(to);
  if (verdict !== 'update' && !(verdict === 'breaking' && breaking)) {
    throw new UpdaterRefusal(
      HTTP_CONFLICT,
      refusal(verdict, formatStackVersion(current), to)
    );
  }
  // The record's startedAt has whole milliseconds; the agent's run starts after this anyway.
  const sentAt = Math.floor(Date.now() / MS_PER_SECOND) * MS_PER_SECOND;
  await deps.agent
    .send(
      {
        action: 'update',
        version: to,
        breaking: verdict === 'breaking',
        requester
      },
      started + REQUEST_BUDGET_MS
    )
    .catch(passOnRefusal);
  return recordSince(
    deps.agent,
    sentAt,
    Math.max(0, started + RESPONSE_BUDGET_MS - Date.now())
  );
}

export function createUpdater(deps: UpdaterDeps): Updater {
  return {
    status: async (fresh, revision) =>
      rateLimited(async () => describeStatus(deps, fresh, revision)),
    update: async body => {
      const started = Date.now();
      return rateLimited(async () => update(deps, body, started));
    },
    host: createHost(deps)
  };
}
