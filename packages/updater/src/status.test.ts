import { describe, expect, it } from 'vitest';

import { GitHubRateLimited } from './releases.js';
import type { ServerDeps } from './server.js';
import type { UpdateVerdict } from './stack.js';
import { describeStatus } from './status.js';

const RUNNING_COMMIT = 'a'.repeat(40);
const EDGE_BUILD = {
  commit: 'b'.repeat(40),
  url: 'https://example/runs/1',
  publishedAt: '2026-10-04T00:00:00Z'
};

/** An edge stack whose running `api` was built from `running`, with every check recorded. */
function edgeDeps(running: string | undefined): ServerDeps & {
  checked: string[];
} {
  const checked: string[] = [];
  return {
    checked,
    token: 'token',
    releases: {
      latest: () =>
        Promise.reject(new Error('an edge stack asks for no release')),
      byVersion: () => Promise.resolve(undefined),
      latestEdge: () => Promise.resolve(EDGE_BUILD)
    },
    currentVersion: () => Promise.resolve('edge'),
    checkUpdate: version => {
      checked.push(version);
      return Promise.resolve<UpdateVerdict>('update');
    },
    runningRevision: () => Promise.resolve(running),
    runner: {
      current: () => ({ state: 'idle' }),
      start: () => Promise.reject(new Error()),
      idle: () => Promise.resolve()
    }
  };
}

describe('describeStatus on an edge stack', () => {
  it('offers main newest build while the stack runs another commit', async () => {
    const deps = edgeDeps(RUNNING_COMMIT);
    expect(await describeStatus(deps)).toMatchObject({
      current: 'edge',
      latest: {
        version: 'edge',
        commit: EDGE_BUILD.commit,
        url: EDGE_BUILD.url,
        publishedAt: EDGE_BUILD.publishedAt
      },
      updatable: true,
      breaking: false
    });
    expect(deps.checked).toEqual(['edge']);
  });

  it('offers nothing once the stack runs that build', async () => {
    const deps = edgeDeps(EDGE_BUILD.commit);
    expect(await describeStatus(deps)).toMatchObject({
      latest: { version: 'edge' },
      updatable: false
    });
    expect(deps.checked).toEqual([]);
  });
});

describe('describeStatus asked to look afresh', () => {
  it('asks for the latest afresh, and fails on a spent GitHub rate limit that a cached look reports', async () => {
    const fresh: (boolean | undefined)[] = [];
    const limited = new GitHubRateLimited('GitHub answered 403', 0);
    const deps: ServerDeps = {
      ...edgeDeps(RUNNING_COMMIT),
      currentVersion: () => Promise.resolve([0, 0, 6]),
      releases: {
        latest: asked => {
          fresh.push(asked);
          return Promise.reject(limited);
        },
        byVersion: () => Promise.resolve(undefined),
        latestEdge: () => Promise.reject(new Error('not edge'))
      }
    };
    await expect(describeStatus(deps, true)).rejects.toBe(limited);
    expect(await describeStatus(deps)).toMatchObject({
      latest: null,
      latestError: 'GitHub answered 403'
    });
    expect(fresh).toEqual([true, false]);
  });
});
