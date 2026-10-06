import { parseVersion, type Version } from './version.js';

/**
 * What the updater installs, as GitHub tells it (§6.3 "Updates"): the project's releases, and for
 * a stack on `edge` main's newest build, the one the latest successful `main.yaml` run published
 * as `edge`. The anonymous GitHub API allows 60 requests an hour per address, so the latest
 * release and the newest edge build are each cached for an hour, a fresh lookup asks at most once
 * a minute, and every request names the ETag of GitHub's last answer to it, whose 304 counts
 * against no limit; a named release is looked up once per update request.
 */
const REPO_API = 'https://api.github.com/repos/zamfono/pbx';
const API = `${REPO_API}/releases`;
const EDGE_RUNS = `${REPO_API}/actions/workflows/main.yaml/runs?branch=main&status=success&per_page=1`;
const CACHE_MS = 3_600_000;
const FRESH_MS = 60_000;
const HTTP_NOT_MODIFIED = 304;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
// Well inside api's own 10 s for the updater's answer, so a host that cannot reach GitHub still
// gets its status, with the reason in `latestError`.
const GITHUB_TIMEOUT_MS = 5000;
// A failed lookup is kept this long, so a host without a way to GitHub does not wait on every
// status request.
const FAILURE_CACHE_MS = 600_000;

/** GitHub's 403 or 429 for a spent rate limit, with when it takes this address's questions
 * again (`retryAt`, ms since the epoch). */
export class GitHubRateLimited extends Error {
  constructor(
    message: string,
    readonly retryAt: number
  ) {
    super(message);
  }
}

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

/** When GitHub, refusing for its rate limit, takes questions again: after its `retry-after`, else
 * at its `x-ratelimit-reset`, else after a minute, as GitHub's REST documentation says. */
function retryTime(headers: Headers, now: number): number {
  const after = headers.get('retry-after');
  if (after !== null) {
    return now + Number(after) * MS_PER_SECOND;
  }
  const reset = headers.get('x-ratelimit-reset');
  return reset === null ? now + FRESH_MS : Number(reset) * MS_PER_SECOND;
}

/** Whether GitHub refused for its rate limit: a 429, or a 403 that says so, with
 * `x-ratelimit-remaining: 0` (the primary limit) or a `retry-after` (the secondary one). */
function rateLimited({ status, headers }: Response): boolean {
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    (status === HTTP_FORBIDDEN &&
      (headers.get('x-ratelimit-remaining') === '0' ||
        headers.has('retry-after')))
  );
}

/** GitHub's refusal of `url` in `response`, or `undefined` for a success or a 404. */
function refusal(
  response: Response,
  url: string,
  now: number
): Error | undefined {
  const { status } = response;
  if (rateLimited(response)) {
    return new GitHubRateLimited(
      `GitHub answered ${status} for ${url}: its rate limit for this address is spent`,
      retryTime(response.headers, now)
    );
  }
  return response.ok || status === HTTP_NOT_FOUND
    ? undefined
    : new Error(`GitHub answered ${status} for ${url}`);
}

export type Releases = {
  /** The newest published release; cached for an hour, `fresh` asks GitHub now, at most once a
   * minute. */
  latest: (fresh?: boolean) => Promise<Release | undefined>;
  /** The published, non-prerelease release `vX.Y.Z`, or `undefined` when GitHub has none. */
  byVersion: (version: string) => Promise<Release | undefined>;
  /** Main's newest build, `edge`; cached like `latest`. */
  latestEdge: (fresh?: boolean) => Promise<EdgeBuild | undefined>;
};

export function createReleases(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now
): Releases {
  const answers = new Map<string, { etag: string; body: unknown }>();

  async function get(url: string): Promise<unknown> {
    const known = answers.get(url);
    const response = await fetchFn(url, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(known === undefined ? {} : { 'if-none-match': known.etag })
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw error instanceof DOMException && error.name === 'TimeoutError'
        ? new Error(`GitHub did not answer within ${GITHUB_TIMEOUT_MS} ms`)
        : error;
    });
    if (response.status === HTTP_NOT_MODIFIED && known !== undefined) {
      return known.body;
    }
    const refused = refusal(response, url, now());
    if (refused !== undefined) {
      throw refused;
    }
    if (response.status === HTTP_NOT_FOUND) {
      return undefined;
    }
    const body: unknown = await response.json();
    const etag = response.headers.get('etag');
    if (etag !== null) {
      answers.set(url, { etag, body });
    }
    return body;
  }

  /** `lookup`, cached for an hour, a failure for `FAILURE_CACHE_MS`; the pending lookup itself is
   * cached, so requests arriving together ask GitHub once. `fresh` looks up anew, unless a fresh
   * lookup began within the last minute. */
  function cached<T>(
    lookup: () => Promise<T | undefined>
  ): (fresh?: boolean) => Promise<T | undefined> {
    let pending: Promise<T | undefined> = Promise.resolve(undefined);
    let expiresAt = Number.NEGATIVE_INFINITY;
    let freshAt = Number.NEGATIVE_INFINITY;
    return async (fresh = false) => {
      if (fresh && now() >= freshAt + FRESH_MS) {
        freshAt = now();
        expiresAt = now();
      }
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
