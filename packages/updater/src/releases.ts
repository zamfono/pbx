import { parseVersion, type Version } from './policy.js';

/**
 * The project's GitHub releases, the only versions the updater installs (§6.3 "Updates"). The
 * anonymous GitHub API allows 60 requests an hour per address, so the latest release is cached
 * for an hour; a named release is looked up once per update request.
 */
const API = 'https://api.github.com/repos/zamfono/pbx/releases';
const CACHE_MS = 3_600_000;
const STATUS_NOT_FOUND = 404;
// Well inside api's own 10 s for the updater's answer, so a host that cannot reach GitHub still
// gets its status, with the reason in `latestError`.
const GITHUB_TIMEOUT_MS = 5000;
// A failed lookup is kept this long, so a host without a way to GitHub does not wait on every
// status request.
const FAILURE_CACHE_MS = 600_000;

/** `promise`, or a rejection after `ms`: fetch's abort signal does not cut a hanging connect. */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  const timer = Promise.withResolvers<never>();
  const handle = setTimeout(() => {
    timer.reject(new Error(`${what} did not answer within ${ms} ms`));
  }, ms);
  try {
    return await Promise.race([promise, timer.promise]);
  } finally {
    clearTimeout(handle);
  }
}

export type Release = { version: Version; url: string; publishedAt: string };

type GitHubRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

function toRelease(body: GitHubRelease): Release | undefined {
  if (body.draft === true || body.prerelease === true) {
    return undefined;
  }
  const version =
    typeof body.tag_name === 'string' ? parseVersion(body.tag_name) : undefined;
  if (version === undefined) {
    return undefined;
  }
  return {
    version,
    url: typeof body.html_url === 'string' ? body.html_url : '',
    publishedAt: typeof body.published_at === 'string' ? body.published_at : ''
  };
}

export type Releases = {
  /** The newest published release; cached for an hour. */
  latest: () => Promise<Release | undefined>;
  /** The published, non-prerelease release `vX.Y.Z`, or `undefined` when GitHub has none. */
  byVersion: (version: string) => Promise<Release | undefined>;
};

export function createReleases(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now
): Releases {
  // The pending lookup itself is cached, so requests arriving together ask GitHub once.
  const cache: { at: number; pending: Promise<Release | undefined> } = {
    at: Number.NEGATIVE_INFINITY,
    pending: Promise.resolve(undefined)
  };

  async function get(url: string): Promise<Release | undefined> {
    const response = await within(
      fetchFn(url, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
      }),
      GITHUB_TIMEOUT_MS,
      'GitHub'
    );
    if (response.status === STATUS_NOT_FOUND) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for ${url}`);
    }
    return toRelease((await response.json()) as GitHubRelease);
  }

  return {
    async latest() {
      if (now() - cache.at >= CACHE_MS) {
        cache.at = now();
        cache.pending = get(`${API}/latest`);
        // A failed lookup is kept for FAILURE_CACHE_MS rather than the full hour.
        cache.pending.catch(() => {
          cache.at = now() - CACHE_MS + FAILURE_CACHE_MS;
        });
      }
      return cache.pending;
    },
    async byVersion(version) {
      return get(`${API}/tags/v${version}`);
    }
  };
}
