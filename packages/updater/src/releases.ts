import { parseVersion, type Version } from './version.js';

/**
 * What the updater installs, as GitHub tells it (§6.3 "Updates"): the project's releases, and for
 * a stack on `edge` main's newest build, the one the latest successful `main.yaml` run published
 * as `edge`. The anonymous GitHub API allows 60 requests an hour per address, so the latest
 * release and the newest edge build are each cached for an hour; a named release is looked up
 * once per update request.
 */
const REPO_API = 'https://api.github.com/repos/zamfono/pbx';
const API = `${REPO_API}/releases`;
const EDGE_RUNS = `${REPO_API}/actions/workflows/main.yaml/runs?branch=main&status=success&per_page=1`;
const CACHE_MS = 3_600_000;
const HTTP_NOT_FOUND = 404;
// Well inside api's own 10 s for the updater's answer, so a host that cannot reach GitHub still
// gets its status, with the reason in `latestError`.
const GITHUB_TIMEOUT_MS = 5000;
// A failed lookup is kept this long, so a host without a way to GitHub does not wait on every
// status request.
const FAILURE_CACHE_MS = 600_000;

export type Release = { version: Version; url: string; publishedAt: string };

/** Main's newest build, published as `edge`: its commit, its `main.yaml` run and when it ended. */
export type EdgeBuild = { commit: string; url: string; publishedAt: string };

type GitHubRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

type GitHubRuns = {
  workflow_runs?: {
    head_sha?: unknown;
    html_url?: unknown;
    updated_at?: unknown;
  }[];
};

/** A published release GitHub describes in full; anything else is none the updater installs. */
function toRelease(body: GitHubRelease): Release | undefined {
  if (body.draft === true || body.prerelease === true) {
    return undefined;
  }
  const version =
    typeof body.tag_name === 'string' ? parseVersion(body.tag_name) : undefined;
  if (
    version === undefined ||
    typeof body.html_url !== 'string' ||
    typeof body.published_at !== 'string'
  ) {
    return undefined;
  }
  return { version, url: body.html_url, publishedAt: body.published_at };
}

/** The build the latest successful `main.yaml` run published, when GitHub describes it in full. */
function toEdgeBuild(body: GitHubRuns): EdgeBuild | undefined {
  const run = body.workflow_runs?.[0];
  if (
    typeof run?.head_sha !== 'string' ||
    typeof run.html_url !== 'string' ||
    typeof run.updated_at !== 'string'
  ) {
    return undefined;
  }
  return {
    commit: run.head_sha,
    url: run.html_url,
    publishedAt: run.updated_at
  };
}

export type Releases = {
  /** The newest published release; cached for an hour. */
  latest: () => Promise<Release | undefined>;
  /** The published, non-prerelease release `vX.Y.Z`, or `undefined` when GitHub has none. */
  byVersion: (version: string) => Promise<Release | undefined>;
  /** Main's newest build, `edge`; cached for an hour. */
  latestEdge: () => Promise<EdgeBuild | undefined>;
};

export function createReleases(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now
): Releases {
  async function get(url: string): Promise<unknown> {
    const response = await fetchFn(url, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw error instanceof DOMException && error.name === 'TimeoutError'
        ? new Error(`GitHub did not answer within ${GITHUB_TIMEOUT_MS} ms`)
        : error;
    });
    if (response.status === HTTP_NOT_FOUND) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for ${url}`);
    }
    return response.json();
  }

  /** `lookup`, cached for an hour, a failure for `FAILURE_CACHE_MS`; the pending lookup itself is
   * cached, so requests arriving together ask GitHub once. */
  function cached<T>(
    lookup: () => Promise<T | undefined>
  ): () => Promise<T | undefined> {
    let pending: Promise<T | undefined> = Promise.resolve(undefined);
    let expiresAt = Number.NEGATIVE_INFINITY;
    return async () => {
      if (now() >= expiresAt) {
        expiresAt = now() + CACHE_MS;
        pending = lookup();
        pending.catch(() => {
          expiresAt = now() + FAILURE_CACHE_MS;
        });
      }
      return pending;
    };
  }

  async function release(url: string): Promise<Release | undefined> {
    const body = await get(url);
    return body === undefined ? undefined : toRelease(body as GitHubRelease);
  }

  return {
    latest: cached(async () => release(`${API}/latest`)),
    async byVersion(version) {
      return release(`${API}/tags/v${version}`);
    },
    latestEdge: cached(async () => {
      const body = await get(EDGE_RUNS);
      return body === undefined ? undefined : toEdgeBuild(body as GitHubRuns);
    })
  };
}
