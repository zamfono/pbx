import { describe, expect, it, vi } from 'vitest';

import { createReleases } from './releases.js';

const HOUR_MS = 3_600_000;
const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;
const STATUS_RATE_LIMITED = 403;

function urlOf(input: URL | Request): string {
  return input instanceof URL ? input.href : input.url;
}

function answering(
  bodies: Record<string, { status: number; body?: unknown }>
): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: typeof fetch = input => {
    const url = typeof input === 'string' ? input : urlOf(input);
    urls.push(url);
    const answer = bodies[url] ?? { status: STATUS_NOT_FOUND };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })
    );
  };
  return { fetchFn, urls };
}

const LATEST = 'https://api.github.com/repos/zamfono/pbx/releases/latest';
const TAG = 'https://api.github.com/repos/zamfono/pbx/releases/tags/v0.0.6';

/* eslint-disable camelcase -- GitHub's own field names */
describe('createReleases', () => {
  it('reads the latest release and caches it for an hour', async () => {
    const { fetchFn, urls } = answering({
      [LATEST]: {
        status: STATUS_OK,
        body: { tag_name: 'v0.0.6', html_url: 'https://example/v0.0.6' }
      }
    });
    const clock = { now: 0 };
    const releases = createReleases(fetchFn, () => clock.now);
    expect((await releases.latest())?.version).toEqual([0, 0, 6]);
    clock.now = HOUR_MS - 1;
    await releases.latest();
    expect(urls).toHaveLength(1);
    clock.now = HOUR_MS;
    await releases.latest();
    expect(urls).toHaveLength(2);
  });

  it('knows no release GitHub does not have, and no prerelease', async () => {
    const { fetchFn } = answering({
      [TAG]: {
        status: STATUS_OK,
        body: { tag_name: 'v0.0.6', prerelease: true }
      }
    });
    const releases = createReleases(fetchFn);
    expect(await releases.byVersion('0.0.6')).toBeUndefined();
    expect(await releases.byVersion('9.9.9')).toBeUndefined();
  });

  it('gives up on a GitHub that does not answer, and keeps that for ten minutes', async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const hanging: typeof fetch = async input => {
        urls.push(typeof input === 'string' ? input : urlOf(input));
        return new Promise<Response>(() => {
          // Never settles: a connect that hangs.
        });
      };
      const clock = { now: 0 };
      const releases = createReleases(hanging, () => clock.now);
      const first = releases.latest();
      const settled = expect(first).rejects.toThrow('did not answer');
      await vi.advanceTimersByTimeAsync(5000);
      await settled;
      clock.now = 9 * 60_000;
      await expect(releases.latest()).rejects.toThrow('did not answer');
      expect(urls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when GitHub does not answer properly', async () => {
    const { fetchFn } = answering({
      [LATEST]: { status: STATUS_RATE_LIMITED }
    });
    await expect(createReleases(fetchFn).latest()).rejects.toThrow('403');
  });
});
/* eslint-enable camelcase -- GitHub's own field names */
