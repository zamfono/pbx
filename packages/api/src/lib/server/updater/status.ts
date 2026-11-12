import type { UpdaterStatus } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

import { GitHubRateLimited } from './releases.js';
import type { UpdaterDeps } from './service.js';
import type { UpdateVerdict } from './stack.js';
import {
  EDGE,
  formatStackVersion,
  formatVersion,
  type StackVersion
} from './version.js';

/**
 * The update status (§6.3 "Updates"): what the stack runs, the newest version it could take, the
 * latest release or, on `edge`, main's newest build, and whether `system.update` would install it.
 */
type Latest = NonNullable<UpdaterStatus['latest']>;

/** Why the stack cannot be updated through `api` at all, `undefined` while it can: without the
 * host agent, or before one of this release reported the stack directory. */
export async function unavailable(
  deps: Pick<UpdaterDeps, 'agent'>
): Promise<string | undefined> {
  return (await deps.agent.present())
    ? undefined
    : 'no host agent has reported the stack directory yet: it does within ten minutes of an update, or install it with setup/agent.sh install on the host (deploy/README.md, step 8)';
}

/** The newest version GitHub names for a stack running `current`, `fresh` asking GitHub now;
 * `newer` is `false` for an `edge` build the stack already runs, the commit `revision` names
 * that `api` was built from. */
async function lookUpLatest(
  deps: UpdaterDeps,
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

/** `fresh` (`system.checkUpdate`) asks GitHub now, at most once a minute, and fails on a spent
 * GitHub rate limit, which the cached status reports in `latestError` like any other failure.
 * `revision` is the commit `api` was built from. */
export async function describeStatus(
  deps: UpdaterDeps,
  fresh = false,
  revision?: string
): Promise<UpdaterStatus> {
  const reason = await unavailable(deps);
  const current =
    reason === undefined ? await deps.currentVersion() : undefined;
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
