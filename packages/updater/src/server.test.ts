import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { UpdateState } from '@zamfono/shared';

import type { Version } from './policy.js';
import type { Release, Releases } from './releases.js';
import type { Runner } from './runner.js';
import { createServer, type ServerDeps } from './server.js';

const TOKEN = 'secret-token';
const STATUS_OK = 200;
const STATUS_ACCEPTED = 202;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_UNAVAILABLE = 503;

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
      )
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
    }
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

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    token: TOKEN,
    releases: fakeReleases([0, 0, 7]),
    currentVersion: () => Promise.resolve([0, 0, 6]),
    runner: fakeRunner(),
    ...overrides
  };
}

describe('the updater API', () => {
  it('refuses a request without the token, and every request without a token set', async () => {
    const base = await serve(deps());
    expect(
      (await call(base, 'GET', '/status', undefined, 'wrong')).status
    ).toBe(STATUS_UNAUTHORIZED);
    const unset = await serve(deps({ token: '' }));
    expect((await call(unset, 'GET', '/status', undefined, '')).status).toBe(
      STATUS_UNAVAILABLE
    );
  });

  it('reports the running and the latest release, and whether it can update', async () => {
    const base = await serve(deps());
    const { status, body } = await call(base, 'GET', '/status');
    expect(status).toBe(STATUS_OK);
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
    const { status, body } = await call(base, 'POST', '/update', {});
    expect(status).toBe(STATUS_ACCEPTED);
    expect(body).toMatchObject({ state: 'running', to: '0.0.7' });
    expect(runner.started).toEqual([['0.0.6', '0.0.7']]);
    expect((await call(base, 'POST', '/update', {})).status).toBe(
      STATUS_CONFLICT
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
      (await call(base, 'POST', '/update', { version: '0.0.9' })).status
    ).toBe(STATUS_NOT_FOUND);
    expect(
      (await call(base, 'POST', '/update', { version: '0.0.5' })).status
    ).toBe(STATUS_CONFLICT);
    const breaking = await call(base, 'POST', '/update', { version: '0.1.0' });
    expect(breaking.status).toBe(STATUS_CONFLICT);
    expect(String(breaking.body.error)).toContain('update.sh');
    expect(
      (await call(base, 'POST', '/update', { version: 'latest' })).status
    ).toBe(STATUS_BAD_REQUEST);
  });

  it('records who asked for the run, and refuses a trigger it does not know', async () => {
    const runner = fakeRunner();
    const base = await serve(deps({ runner }));
    expect(
      (await call(base, 'POST', '/update', { trigger: 'host' })).status
    ).toBe(STATUS_BAD_REQUEST);
    expect(
      (await call(base, 'POST', '/update', { trigger: 'manual', by: 7 })).status
    ).toBe(STATUS_BAD_REQUEST);
    expect(runner.started).toEqual([]);

    const { status, body } = await call(base, 'POST', '/update', {
      trigger: 'manual',
      by: 'Olga Owner'
    });
    expect(status).toBe(STATUS_ACCEPTED);
    expect(body).toMatchObject({ trigger: 'manual', by: 'Olga Owner' });
  });

  it('refuses updates while it cannot run them, and says why', async () => {
    const base = await serve(
      deps({ runner: undefined, unavailable: 'no labels' })
    );
    const { status, body } = await call(base, 'POST', '/update', {});
    expect(status).toBe(STATUS_UNAVAILABLE);
    expect(body.error).toBe('no labels');
    expect((await call(base, 'GET', '/status')).body).toMatchObject({
      updatable: false,
      unavailable: 'no labels'
    });
  });
});
