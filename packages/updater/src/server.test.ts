import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostStatus, UpdateState } from '@zamfono/shared';

import { AgentRefusal, type Agent, type AgentRequest } from './agent.js';
import { GitHubRateLimited, type Release, type Releases } from './releases.js';
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

/** An agent that takes every request and, for an update, records its run as begun. */
function fakeAgent(
  options: { from?: string; present?: boolean; host?: HostStatus } = {}
): Agent & { sent: AgentRequest[]; running: () => void } {
  let state: UpdateState = { state: 'idle' };
  const sent: AgentRequest[] = [];
  return {
    sent,
    running: () => {
      state = { state: 'running', startedAt: new Date().toISOString() };
    },
    present: () => Promise.resolve(options.present ?? true),
    state: () => state,
    host: () => Promise.resolve(options.host),
    send: request => {
      sent.push(request);
      if (request.action === 'update') {
        state = {
          state: 'running',
          from: options.from ?? '0.0.6',
          to: request.version,
          ...request.requester,
          startedAt: new Date(Date.now() + 1000).toISOString()
        };
      }
      return Promise.resolve();
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
    agent: fakeAgent(),
    hostControl: false,
    ...overrides
  };
}

const NO_REBOOT: HostStatus = { rebootRequired: null, updates: false };

describe('the host API', () => {
  it('offers nothing while HOST_CONTROL is not true', async () => {
    const base = await serve(deps({ agent: fakeAgent({ host: NO_REBOOT }) }));
    const answers = await Promise.all([
      call(base, 'GET', '/host'),
      call(base, 'POST', '/host/updates'),
      call(base, 'POST', '/host/reboot')
    ]);
    expect(answers.map(answer => answer.status)).toEqual([
      HTTP_NOT_FOUND,
      HTTP_NOT_FOUND,
      HTTP_NOT_FOUND
    ]);
  });

  it("reports what the agent saw of the host, and hands it the upgrades' switch", async () => {
    const agent = fakeAgent({ host: NO_REBOOT });
    const base = await serve(deps({ agent, hostControl: true }));
    expect((await call(base, 'GET', '/host')).body).toEqual(NO_REBOOT);
    expect(
      (await call(base, 'POST', '/host/updates', { enabled: 'yes' })).status
    ).toBe(HTTP_BAD_REQUEST);
    expect(
      (await call(base, 'POST', '/host/updates', { enabled: true })).status
    ).toBe(HTTP_ACCEPTED);
    expect(agent.sent).toEqual([{ action: 'updates', enabled: true }]);
  });

  it('says so before the agent reported the host, and refuses upgrades without apt', async () => {
    const silent = await serve(deps({ agent: fakeAgent(), hostControl: true }));
    expect((await call(silent, 'GET', '/host')).status).toBe(
      HTTP_SERVICE_UNAVAILABLE
    );
    const agent = fakeAgent({ host: { rebootRequired: null, updates: null } });
    const noApt = await serve(deps({ agent, hostControl: true }));
    expect(
      (await call(noApt, 'POST', '/host/updates', { enabled: true })).status
    ).toBe(HTTP_CONFLICT);
    expect(agent.sent).toEqual([]);
  });

  it('asks for a reboot, unless an update runs or the stack would not come back', async () => {
    const agent = fakeAgent({ host: NO_REBOOT });
    const base = await serve(deps({ agent, hostControl: true }));
    expect((await call(base, 'POST', '/host/reboot')).status).toBe(
      HTTP_ACCEPTED
    );
    expect(agent.sent).toEqual([{ action: 'reboot' }]);

    const busy = fakeAgent({ host: NO_REBOOT });
    busy.running();
    expect(
      (
        await call(
          await serve(deps({ agent: busy, hostControl: true })),
          'POST',
          '/host/reboot'
        )
      ).status
    ).toBe(HTTP_CONFLICT);

    const podman = fakeAgent({
      host: { ...NO_REBOOT, rebootRefused: 'no boot unit' }
    });
    const refused = await call(
      await serve(deps({ agent: podman, hostControl: true })),
      'POST',
      '/host/reboot'
    );
    expect(refused).toMatchObject({
      status: HTTP_CONFLICT,
      body: { error: 'no boot unit' }
    });
    expect(podman.sent).toEqual([]);
  });

  it('has the agent read the host now, and answers with its report', async () => {
    const agent = fakeAgent({ host: NO_REBOOT });
    const base = await serve(deps({ agent, hostControl: true }));
    expect(await call(base, 'POST', '/host/check')).toEqual({
      status: HTTP_OK,
      body: NO_REBOOT
    });
    expect(agent.sent).toEqual([{ action: 'report' }]);
  });

  it("shares one check among those asked at once, and passes the agent's refusal on as 409", async () => {
    const agent = fakeAgent({ host: NO_REBOOT });
    const base = await serve(deps({ agent, hostControl: true }));
    const answers = await Promise.all([
      call(base, 'POST', '/host/check'),
      call(base, 'POST', '/host/check')
    ]);
    expect(answers.map(answer => answer.status)).toEqual([HTTP_OK, HTTP_OK]);
    expect(agent.sent.length).toBeLessThanOrEqual(2);
    const refusing: Agent = {
      ...fakeAgent({ host: NO_REBOOT }),
      send: () =>
        Promise.reject(
          new AgentRefusal(
            'refused',
            'the host agent refused: an update is running'
          )
        )
    };
    expect(
      await call(
        await serve(deps({ agent: refusing, hostControl: true })),
        'POST',
        '/host/reboot'
      )
    ).toMatchObject({
      status: HTTP_CONFLICT,
      body: { error: 'the host agent refused: an update is running' }
    });
  });

  it('passes on an agent that does not take the request', async () => {
    const agent: Agent = {
      ...fakeAgent({ host: NO_REBOOT }),
      send: () =>
        Promise.reject(new AgentRefusal('notTaken', 'did not take it'))
    };
    const answer = await call(
      await serve(deps({ agent, hostControl: true })),
      'POST',
      '/host/reboot'
    );
    expect(answer).toMatchObject({
      status: HTTP_SERVICE_UNAVAILABLE,
      body: { error: 'did not take it' }
    });
  });
});

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

  it("hands an update to the latest release to the host agent, and answers with the run's record", async () => {
    const agent = fakeAgent();
    const base = await serve(deps({ agent }));
    const { status, body } = await call(base, 'POST', '/update', MANUAL);
    expect(status).toBe(HTTP_ACCEPTED);
    expect(body).toMatchObject({ state: 'running', to: '0.0.7' });
    expect(agent.sent).toEqual([
      {
        action: 'update',
        version: '0.0.7',
        breaking: false,
        requester: MANUAL
      }
    ]);
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
      (
        await call(base, 'POST', '/update', {
          trigger: 'automatic',
          version: '0.1.0',
          breaking: true
        })
      ).status
    ).toBe(HTTP_BAD_REQUEST);
    expect(
      (await call(base, 'POST', '/update', { ...MANUAL, version: 'latest' }))
        .status
    ).toBe(HTTP_BAD_REQUEST);
  });

  it('takes a breaking release when the owner sets breaking, which the agent passes on as --yes', async () => {
    const agent = fakeAgent();
    const base = await serve(
      deps({ releases: fakeReleases([0, 1, 0]), agent })
    );
    const { status, body } = await call(base, 'POST', '/update', {
      ...MANUAL,
      breaking: true
    });
    expect(status).toBe(HTTP_ACCEPTED);
    expect(body).toMatchObject({ state: 'running', to: '0.1.0' });
    expect(agent.sent).toMatchObject([{ version: '0.1.0', breaking: true }]);
  });

  it.each([
    {},
    { trigger: 'host' },
    { trigger: 'manual' },
    { trigger: 'manual', by: 7 },
    { trigger: 'automatic', by: 'Zamfono' },
    { trigger: 'manual', by: '' },
    { trigger: 'manual', by: 'Olga\nversion=9.9.9' },
    // 101 characters, 201 bytes: the host agent counts bytes.
    { trigger: 'manual', by: `${'Ł'.repeat(100)}x` }
  ])('refuses the requester %j', async requester => {
    const agent = fakeAgent();
    const base = await serve(deps({ agent }));
    expect((await call(base, 'POST', '/update', requester)).status).toBe(
      HTTP_BAD_REQUEST
    );
    expect(agent.sent).toEqual([]);
  });

  it('records who asked for the run', async () => {
    const base = await serve(deps());
    const { status, body } = await call(base, 'POST', '/update', {
      trigger: 'manual',
      by: 'Olga Owner'
    });
    expect(status).toBe(HTTP_ACCEPTED);
    expect(body).toMatchObject({ trigger: 'manual', by: 'Olga Owner' });
  });

  it('refuses updates while no host agent has run, and says why', async () => {
    const base = await serve(deps({ agent: fakeAgent({ present: false }) }));
    const { status, body } = await call(base, 'POST', '/update', MANUAL);
    expect(status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(String(body.error)).toContain('setup/agent.sh install');
    expect((await call(base, 'GET', '/status')).body).toMatchObject({
      updatable: false,
      unavailable: body.error
    });
  });

  it('refuses an update while a request still waits for the agent', async () => {
    const agent: Agent = {
      ...fakeAgent(),
      send: () => Promise.reject(new AgentRefusal('pending', 'still waits'))
    };
    expect(
      (await call(await serve(deps({ agent })), 'POST', '/update', MANUAL))
        .status
    ).toBe(HTTP_CONFLICT);
  });

  it("compares an edge stack's newest build with the commit api names", async () => {
    const base = await serve(
      deps({ currentVersion: () => Promise.resolve('edge') })
    );
    expect(
      (await call(base, 'GET', `/status?revision=${RUNNING_COMMIT}`)).body
    ).toMatchObject({ updatable: true });
    expect(
      (await call(base, 'GET', `/status?revision=${EDGE_BUILD.commit}`)).body
    ).toMatchObject({ updatable: false });
  });

  it('updates an edge stack to edge alone', async () => {
    const agent = fakeAgent({ from: 'edge' });
    const base = await serve(
      deps({ agent, currentVersion: () => Promise.resolve('edge') })
    );
    const refused = await call(base, 'POST', '/update', {
      ...MANUAL,
      version: '0.0.7'
    });
    expect(refused.status).toBe(HTTP_CONFLICT);
    expect(refused.body.error).toContain('follows edge');
    expect(agent.sent).toEqual([]);
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
