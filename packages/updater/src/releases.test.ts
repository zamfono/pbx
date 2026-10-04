import { describe, expect, it, vi } from 'vitest';

import { createReleases } from './releases.js';

const HOUR_MS = 3_600_000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
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
    const answer = bodies[url] ?? { status: HTTP_NOT_FOUND };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })
    );
  };
  return { fetchFn, urls };
}

const LATEST = 'https://api.github.com/repos/zamfono/pbx/releases/latest';
const TAG = 'https://api.github.com/repos/zamfono/pbx/releases/tags/v0.0.6';
describe('createReleases', () => {
  it('reads the latest release and caches it for an hour', async () => {
    const { fetchFn, urls } = answering({
      [LATEST]: {
        status: HTTP_OK,
        body: {
          tag_name: 'v0.0.6',
          html_url: 'https://example/v0.0.6',
          published_at: '2026-10-01T10:00:00Z'
        }
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
        status: HTTP_OK,
        body: { tag_name: 'v0.0.6', prerelease: true }
      }
    });
    const releases = createReleases(fetchFn);
    expect(await releases.byVersion('0.0.6')).toBeUndefined();
    expect(await releases.byVersion('9.9.9')).toBeUndefined();
  });

  it('knows no release GitHub describes without its page or date', async () => {
    const { fetchFn } = answering({
      [TAG]: { status: HTTP_OK, body: { tag_name: 'v0.0.6' } }
    });
    expect(await createReleases(fetchFn).byVersion('0.0.6')).toBeUndefined();
  });

  it('gives up on a GitHub that does not answer, and keeps that for ten minutes', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    try {
      const urls: string[] = [];
      // A connect that hangs until the request's signal aborts it, as fetch's does.
      const hanging: typeof fetch = async (input, init) => {
        urls.push(typeof input === 'string' ? input : urlOf(input));
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            reject(init?.signal?.reason as Error);
          };
          if (init?.signal?.aborted === true) {
            abort();
          }
          init?.signal?.addEventListener('abort', abort);
        });
      };
      let clock = 0;
      const releases = createReleases(hanging, () => clock);
      const first = releases.latest();
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      timeout.abort(new DOMException('timed out', 'TimeoutError'));
      await expect(first).rejects.toThrow('did not answer within 5000 ms');
      clock = 9 * 60_000;
      await expect(releases.latest()).rejects.toThrow('did not answer');
      expect(urls).toHaveLength(1);
      clock = 10 * 60_000;
      await expect(releases.latest()).rejects.toThrow('did not answer');
      expect(urls).toHaveLength(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('fails when GitHub does not answer properly', async () => {
    const { fetchFn } = answering({
      [LATEST]: { status: STATUS_RATE_LIMITED }
    });
    await expect(createReleases(fetchFn).latest()).rejects.toThrow('403');
  });

  it('reads main newest build off the latest successful main.yaml run, cached for an hour', async () => {
    const runs =
      'https://api.github.com/repos/zamfono/pbx/actions/workflows/main.yaml/runs?branch=main&status=success&per_page=1';
    const { fetchFn, urls } = answering({
      [runs]: {
        status: HTTP_OK,
        body: {
          workflow_runs: [
            {
              head_sha: 'b'.repeat(40),
              html_url: 'https://example/runs/1',
              updated_at: '2026-10-04T00:00:00Z'
            }
          ]
        }
      }
    });
    const clock = { now: 0 };
    const releases = createReleases(fetchFn, () => clock.now);
    expect(await releases.latestEdge()).toEqual({
      commit: 'b'.repeat(40),
      url: 'https://example/runs/1',
      publishedAt: '2026-10-04T00:00:00Z'
    });
    clock.now = HOUR_MS - 1;
    await releases.latestEdge();
    expect(urls).toEqual([runs]);
  });
});
