import type { UpdaterStatus } from '@zamfono/shared';

import { errorMessage } from './errors.js';
import { GitHubRateLimited } from './releases.js';
import type { ServerDeps } from './server.js';
import type { UpdateVerdict } from './stack.js';
import {
  EDGE,
  formatStackVersion,
  formatVersion,
  type StackVersion
} from './version.js';

/**
 * `GET /status` and `POST /check` (§6.3 "Updates"): what the stack runs, the newest version it
 * could take, the latest release or, on `edge`, main's newest build, and whether the updater would
 * install it.
 */
type Latest = NonNullable<UpdaterStatus['latest']>;

/** Why the updater cannot update at all, `undefined` while it can: without the host agent. */
export async function unavailable(
  deps: Pick<ServerDeps, 'agent'>
): Promise<string | undefined> {
  return (await deps.agent.present())
    ? undefined
    : 'no host agent has run for the stack directory: install it with setup/agent.sh install on the host (deploy/README.md, step 5)';
}

/** The newest version GitHub names for a stack running `current`, `fresh` asking GitHub now;
 * `newer` is `false` for an `edge` build the stack already runs, the commit `revision` names
 * that `api` was built from. */
async function lookUpLatest(
  deps: ServerDeps,
  current: StackVersion | undefined,
  fresh: boolean,
  revision: string | undefined
): Promise<{ latest: Latest; newer: boolean } | undefined> {
  if (current === EDGE) {
    const build = await deps.releases.latestEdge(fresh);
    if (build === undefined) {
      return undefined;
    }
    const { commit, url, publishedAt } = build;
    return {
      latest: { version: EDGE, commit, url, publishedAt },
      newer: build.commit !== revision
    };
  }
  const release = await deps.releases.latest(fresh);
  return release === undefined
    ? undefined
    : {
        latest: { ...release, version: formatVersion(release.version) },
        newer: true
      };
}

/** `fresh` (`POST /check`) asks GitHub now, at most once a minute, and fails on a spent GitHub
 * rate limit, which `GET /status` reports in `latestError` like any other failure. `revision` is
 * the commit `api` was built from, which `api` names. */
export async function describeStatus(
  deps: ServerDeps,
  fresh = false,
  revision?: string
): Promise<UpdaterStatus> {
  const current = await deps.currentVersion();
  const reason = await unavailable(deps);
  const base = {
    current: current === undefined ? null : formatStackVersion(current),
    last: deps.agent.state(),
    ...(reason === undefined ? {} : { unavailable: reason })
  };
  let found: Awaited<ReturnType<typeof lookUpLatest>>;
  try {
    found = await lookUpLatest(deps, current, fresh, revision);
  } catch (error) {
    if (fresh && error instanceof GitHubRateLimited) {
      throw error;
    }
    return {
      ...base,
      latest: null,
      latestError: errorMessage(error),
      updatable: false,
      breaking: false
    };
  }
  let verdict: UpdateVerdict | undefined;
  if (found !== undefined && current !== undefined) {
    verdict = found.newer
      ? await deps.checkUpdate(found.latest.version)
      : 'notNewer';
  }
  return {
    ...base,
    latest: found?.latest ?? null,
    updatable: verdict === 'update' && reason === undefined,
    breaking: verdict === 'breaking'
  };
}
