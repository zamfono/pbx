import { parseVersion, type Version } from './version.js';

/**
 * The project's GitHub releases, the only versions the updater installs (§6.3 "Updates"). The
 * anonymous GitHub API allows 60 requests an hour per address, so the latest release is cached
 * for an hour; a named release is looked up once per update request.
 */
const API = 'https://api.github.com/repos/zamfono/pbx/releases';
const CACHE_MS = 3_600_000;
const HTTP_NOT_FOUND = 404;
// Well inside api's own 10 s for the updater's answer, so a host that cannot reach GitHub still
// gets its status, with the reason in `latestError`.
const GITHUB_TIMEOUT_MS = 5000;
// A failed lookup is kept this long, so a host without a way to GitHub does not wait on every
// status request.
const FAILURE_CACHE_MS = 600_000;

export type Release = { version: Version; url: string; publishedAt: string };

type GitHubRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
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
  let pending: Promise<Release | undefined> = Promise.resolve(undefined);
  let expiresAt = Number.NEGATIVE_INFINITY;

  async function get(url: string): Promise<Release | undefined> {
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
    return toRelease((await response.json()) as GitHubRelease);
  }

  return {
    async latest() {
      if (now() >= expiresAt) {
        expiresAt = now() + CACHE_MS;
        pending = get(`${API}/latest`);
        pending.catch(() => {
          expiresAt = now() + FAILURE_CACHE_MS;
        });
      }
      return pending;
    },
    async byVersion(version) {
      return get(`${API}/tags/v${version}`);
    }
  };
}
