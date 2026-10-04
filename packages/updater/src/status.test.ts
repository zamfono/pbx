import { describe, expect, it } from 'vitest';

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
      start: () => Promise.reject(new Error())
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
