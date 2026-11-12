import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  type HostStatus
} from '@zamfono/shared';

import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { OpError } from '../types.js';

import '../index.js';

import { rebootRequest } from './_host.js';
import { hostClient, UpdaterRefusal, type HostClient } from './_updater.js';

vi.mock('./_updater.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./_updater.js')>()),
  hostClient: vi.fn()
}));

const asOwner: RunInput = {
  actor: { id: 'o1', name: 'Olga Owner', role: 'owner' },
  channel: 'mcp',
  requestId: 'req-1',
  confirm: true
};

function fakeHost(
  status: HostStatus = { rebootRequired: null, updates: true },
  reboot: () => Promise<void> = () => Promise.resolve()
): HostClient & { reboots: number } {
  const host = {
    reboots: 0,
    read: () => Promise.resolve(status),
    check: () => Promise.resolve(status),
    setUpdates: () => Promise.resolve(),
    reboot: async () => {
      host.reboots += 1;
      await reboot();
    }
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
});

describe('system.reboot (§6.3 "Host control")', () => {
  it('is unknown without HOST_CONTROL', async () => {
    vi.stubEnv('HOST_CONTROL', '');
    const db = await makeTestDb();
    await expect(
      runOperation(db, 'system.reboot', { when: 'now' }, asOwner)
    ).rejects.toMatchObject({ status: HTTP_NOT_FOUND });
  });

  it('reboots now, dropping a scheduled reboot', async () => {
    const db = await makeTestDb();
    const host = fakeHost();
    vi.mocked(hostClient).mockReturnValue(host);
    await runOperation(db, 'system.reboot', { when: 'maintenance' }, asOwner);
    await expect(rebootRequest(db)).resolves.toMatchObject({
      by: 'Olga Owner'
    });
    // The audit entry says when.
    const entry = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'system.reboot')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual([
      { field: 'when', from: null, to: 'maintenance' }
    ]);
    await expect(
      runOperation(db, 'system.reboot', { when: 'now' }, asOwner)
    ).resolves.toEqual({ when: 'now' });
    expect(host.reboots).toBe(1);
    await expect(rebootRequest(db)).resolves.toBeNull();
  });

  it("passes on the updater's refusal while an update runs", async () => {
    const db = await makeTestDb();
    vi.mocked(hostClient).mockReturnValue(
      fakeHost(undefined, () =>
        Promise.reject(
          new UpdaterRefusal(HTTP_CONFLICT, 'an update is running')
        )
      )
    );
    const refusal = runOperation(db, 'system.reboot', { when: 'now' }, asOwner);
    await expect(refusal).rejects.toBeInstanceOf(OpError);
    await expect(refusal).rejects.toMatchObject({ status: HTTP_CONFLICT });
  });

  it('schedules no reboot the stack would not come back from', async () => {
    const db = await makeTestDb();
    vi.mocked(hostClient).mockReturnValue(
      fakeHost({ rebootRequired: null, updates: true, rebootRefused: 'Podman' })
    );
    await expect(
      runOperation(db, 'system.reboot', { when: 'maintenance' }, asOwner)
    ).rejects.toMatchObject({ status: HTTP_CONFLICT });
    await expect(rebootRequest(db)).resolves.toBeNull();
  });

  it('is an owner action', async () => {
    const db = await makeTestDb();
    vi.mocked(hostClient).mockReturnValue(fakeHost());
    await expect(
      runOperation(
        db,
        'system.reboot',
        { when: 'now' },
        { ...asOwner, actor: { id: 'a1', name: 'Admin', role: 'admin' } }
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});
