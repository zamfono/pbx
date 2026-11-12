import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HTTP_NOT_FOUND, type HostStatus } from '@zamfono/shared';

import { runHostPassNow } from '#lib/server/jobs/host.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

import { hostClient, type HostClient } from './_updater.js';

vi.mock('./_updater.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./_updater.js')>()),
  hostClient: vi.fn()
}));
vi.mock('#lib/server/jobs/host.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#lib/server/jobs/host.js')>()),
  runHostPassNow: vi.fn()
}));

const asAdmin: RunInput = {
  actor: { id: 'a1', name: 'Admin', role: 'admin' },
  channel: 'mcp',
  requestId: 'req-1'
};

const WAITING: HostStatus = {
  rebootRequired: {
    since: '2026-11-12T04:10:00.000Z',
    packages: ['linux-image-amd64']
  },
  updates: true
};

function fakeHost(): HostClient & { checks: number } {
  const host = {
    checks: 0,
    read: () => Promise.reject(new Error('a check reads afresh')),
    check: () => {
      host.checks += 1;
      return Promise.resolve(WAITING);
    },
    setUpdates: () => Promise.resolve(),
    reboot: () => Promise.resolve()
  };
  return host;
}

beforeEach(() => {
  vi.stubEnv('HOST_CONTROL', 'true');
  vi.stubEnv('UPDATER_TOKEN', 'token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(hostClient).mockReset();
  vi.mocked(runHostPassNow).mockReset();
});

describe('system.checkHost (§6.3 "Host control")', () => {
  it('is unknown without HOST_CONTROL', async () => {
    vi.stubEnv('HOST_CONTROL', '');
    await expect(
      runOperation(await makeTestDb(), 'system.checkHost', {}, asAdmin)
    ).rejects.toMatchObject({ status: HTTP_NOT_FOUND });
  });

  it("has the agent read the host now, answers with system.info's host block and runs api's own pass", async () => {
    const host = fakeHost();
    vi.mocked(hostClient).mockReturnValue(host);
    await expect(
      runOperation(await makeTestDb(), 'system.checkHost', {}, asAdmin)
    ).resolves.toEqual({
      rebootRequired: WAITING.rebootRequired,
      rebootScheduled: null
    });
    expect(host.checks).toBe(1);
    expect(runHostPassNow).toHaveBeenCalledOnce();
  });
});
