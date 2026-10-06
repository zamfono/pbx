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

/** The newest version GitHub names for a stack running `current`, `fresh` asking GitHub now;
 * `newer` is `false` for an `edge` build the stack already runs, which only the running commit
 * tells. */
async function lookUpLatest(
  deps: ServerDeps,
  current: StackVersion | undefined,
  fresh: boolean
): Promise<{ latest: Latest; newer: boolean } | undefined> {
  if (current === EDGE) {
    const build = await deps.releases.latestEdge(fresh);
    if (build === undefined) {
      return undefined;
    }
    const { commit, url, publishedAt } = build;
    return {
      latest: { version: EDGE, commit, url, publishedAt },
      newer: build.commit !== (await deps.runningRevision())
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
 * rate limit, which `GET /status` reports in `latestError` like any other failure. */
export async function describeStatus(
  deps: ServerDeps,
  fresh = false
): Promise<UpdaterStatus> {
  const current = await deps.currentVersion();
  const base = {
    current: current === undefined ? null : formatStackVersion(current),
    last: deps.runner?.current() ?? { state: 'idle' as const },
    ...(deps.unavailable === undefined ? {} : { unavailable: deps.unavailable })
  };
  let found: Awaited<ReturnType<typeof lookUpLatest>>;
  try {
    found = await lookUpLatest(deps, current, fresh);
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
    updatable: verdict === 'update' && deps.runner !== undefined,
    breaking: verdict === 'breaking'
  };
}
