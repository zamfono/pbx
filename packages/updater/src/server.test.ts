import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { UpdateState } from '@zamfono/shared';

import { GitHubRateLimited, type Release, type Releases } from './releases.js';
import type { Runner } from './runner.js';
import { createServer, type ServerDeps } from './server.js';
import type { UpdateVerdict } from './stack.js';
import type { Version } from './version.js';

const TOKEN = 'secret-token';
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MANUAL = { trigger: 'manual', by: 'Olga Owner' };

const RUNNING_COMMIT = 'a'.repeat(40);
const EDGE_BUILD = {
  commit: 'b'.repeat(40),
  url: 'https://example/runs/1',
  publishedAt: '2026-10-04T00:00:00Z'
};

function release(version: Version): Release {
  return {
    version,
    url: `https://example/v${version.join('.')}`,
    publishedAt: ''
  };
}

function fakeReleases(latest: Version, known: Version[] = [latest]): Releases {
  return {
    latest: () => Promise.resolve(release(latest)),
    byVersion: text =>
      Promise.resolve(
        known.map(release).find(item => item.version.join('.') === text)
      ),
    latestEdge: () => Promise.resolve(EDGE_BUILD)
  };
}

function fakeRunner(): Runner & { started: string[][] } {
  let state: UpdateState = { state: 'idle' };
  const started: string[][] = [];
  return {
    started,
    current: () => state,
    start: (from, to, requester) => {
      started.push([from, to]);
      state = { state: 'running', from, to, ...requester };
      return Promise.resolve({ finished: Promise.resolve() });
    },
    idle: () => Promise.resolve()
  };
}

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function serve(serverDeps: ServerDeps): Promise<string> {
  const server = createServer(serverDeps);
  servers.push(server);
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(
  base: string,
  method: string,
  route: string,
  body?: unknown,
  token = TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>
  };
}

/** update.sh --check's verdicts on the stack at 0.0.6, which the tests stub. */
const VERDICTS: Record<string, UpdateVerdict> = {
  '0.0.5': 'notNewer',
  '0.0.6': 'notNewer',
  '0.0.7': 'update',
  '0.1.0': 'breaking'
};

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    token: TOKEN,
    releases: fakeReleases([0, 0, 7]),
    currentVersion: () => Promise.resolve([0, 0, 6]),
    checkUpdate: version => Promise.resolve(VERDICTS[version] ?? 'update'),
    runningRevision: () => Promise.resolve(RUNNING_COMMIT),
    runner: fakeRunner(),
    ...overrides
  };
}

describe('the updater API', () => {
  it('refuses a request without the token, and every request without a token set', async () => {
    const base = await serve(deps());
    expect(
      (await call(base, 'GET', '/status', undefined, 'wrong')).status
    ).toBe(HTTP_UNAUTHORIZED);
    const unset = await serve(deps({ token: undefined }));
    expect((await call(unset, 'GET', '/status', undefined, '')).status).toBe(
      HTTP_SERVICE_UNAVAILABLE
    );
  });

  it('reports the running and the latest release, and whether it can update', async () => {
    const base = await serve(deps());
    const { status, body } = await call(base, 'GET', '/status');
    expect(status).toBe(HTTP_OK);
    expect(body).toMatchObject({
      current: '0.0.6',
      latest: { version: '0.0.7' },
      updatable: true,
      breaking: false,
      last: { state: 'idle' }
    });
  });

  it('calls a newer breaking release breaking, not updatable', async () => {
    const base = await serve(deps({ releases: fakeReleases([0, 1, 0]) }));
    expect((await call(base, 'GET', '/status')).body).toMatchObject({
      updatable: false,
      breaking: true
    });
  });

  it('starts an update to the latest release and answers at once', async () => {
    const runner = fakeRunner();
    const base = await serve(deps({ runner }));
    const { status, body } = await call(base, 'POST', '/update', MANUAL);
    expect(status).toBe(HTTP_ACCEPTED);
    expect(body).toMatchObject({ state: 'running', to: '0.0.7' });
    expect(runner.started).toEqual([['0.0.6', '0.0.7']]);
    expect((await call(base, 'POST', '/update', MANUAL)).status).toBe(
      HTTP_CONFLICT
    );
  });

  it('takes a named release only if GitHub has it, and only a non-breaking newer one', async () => {
    const base = await serve(
      deps({
        releases: fakeReleases(
          [0, 1, 0],
          [
            [0, 0, 5],
            [0, 1, 0]
          ]
        )
      })
    );
    expect(
      (await call(base, 'POST', '/update', { ...MANUAL, version: '0.0.9' }))
        .status
    ).toBe(HTTP_NOT_FOUND);
    expect(
      (await call(base, 'POST', '/update', { ...MANUAL, version: '0.0.5' }))
        .status
    ).toBe(HTTP_CONFLICT);
    const breaking = await call(base, 'POST', '/update', {
      ...MANUAL,
      version: '0.1.0'
    });
    expect(breaking.status).toBe(HTTP_CONFLICT);
    expect(String(breaking.body.error)).toContain('update.sh');
    expect(
      (await call(base, 'POST', '/update', { ...MANUAL, version: 'latest' }))
        .status
    ).toBe(HTTP_BAD_REQUEST);
  });

  it.each([
    {},
    { trigger: 'host' },
    { trigger: 'manual' },
    { trigger: 'manual', by: 7 },
    { trigger: 'automatic', by: 'Zamfono' }
  ])('refuses the requester %j', async requester => {
    const runner = fakeRunner();
    const base = await serve(deps({ runner }));
    expect((await call(base, 'POST', '/update', requester)).status).toBe(
      HTTP_BAD_REQUEST
    );
    expect(runner.started).toEqual([]);
  });

  it('records who asked for the run', async () => {
    const runner = fakeRunner();
    const base = await serve(deps({ runner }));
    const { status, body } = await call(base, 'POST', '/update', {
      trigger: 'manual',
      by: 'Olga Owner'
    });
    expect(status).toBe(HTTP_ACCEPTED);
    expect(body).toMatchObject({ trigger: 'manual', by: 'Olga Owner' });
  });

  it('refuses updates while it cannot run them, and says why', async () => {
    const base = await serve(
      deps({ runner: undefined, unavailable: 'no labels' })
    );
    const { status, body } = await call(base, 'POST', '/update', {});
    expect(status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(body.error).toBe('no labels');
    expect((await call(base, 'GET', '/status')).body).toMatchObject({
      updatable: false,
      unavailable: 'no labels'
    });
  });

  it('updates an edge stack to edge alone', async () => {
    const runner = fakeRunner();
    const base = await serve(
      deps({ runner, currentVersion: () => Promise.resolve('edge') })
    );
    const refused = await call(base, 'POST', '/update', {
      ...MANUAL,
      version: '0.0.7'
    });
    expect(refused.status).toBe(HTTP_CONFLICT);
    expect(refused.body.error).toContain('follows edge');
    expect(runner.started).toEqual([]);
    const { status, body } = await call(base, 'POST', '/update', {
      trigger: 'automatic',
      version: 'edge'
    });
    expect(status).toBe(HTTP_ACCEPTED);
    expect(body).toMatchObject({ from: 'edge', to: 'edge' });
  });

  it('looks the latest up afresh, and passes a spent GitHub rate limit on with when to retry', async () => {
    const base = await serve(deps());
    const { status, body } = await call(base, 'POST', '/check');
    expect(status).toBe(HTTP_OK);
    expect(body).toMatchObject({ latest: { version: '0.0.7' } });
    const limited = await serve(
      deps({
        releases: {
          ...fakeReleases([0, 0, 7]),
          latest: () =>
            Promise.reject(
              new GitHubRateLimited('rate limited', Date.now() + 120_000)
            )
        }
      })
    );
    const response = await fetch(`${limited}/check`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(await response.json()).toEqual({ error: 'rate limited' });
  });
});
