import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceRow } from '../../provisioning/types.js';
import { makeTestDb } from '../../testDb.js';
import type { Context } from '../types.js';
import { restoreProvisionedDevices } from './restoreProvisioning.js';

const created: DeviceRow[] = [];

vi.mock('../../provisioning/index.js', () => ({
  activeRingotelProvider: () =>
    Promise.resolve({
      onDeviceCreated: (device: DeviceRow) => {
        created.push(device);
        return Promise.resolve();
      },
      onDeviceDeleted: () => Promise.resolve(),
      onCredentialsRotated: () => Promise.resolve()
    })
}));

vi.mock('../../secretbox.js', () => ({
  keyringFromEnv: () => ({}),
  decrypt: () => Buffer.from('sip-secret')
}));

describe('restoreProvisionedDevices', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('pushes a restored ringotel device back to the provider (§10.4)', async () => {
    const db = await makeTestDb();
    const userId = 'owner';
    await db
      .insertInto('devices')
      .values({
        id: 'dev-1',
        userId,
        label: 'Phone',
        kind: 'ringotel',
        sipUsername: 'e101-dabc',
        sipPasswordEnc: Buffer.from('enc'),
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .execute();

    await restoreProvisionedDevices(
      { db } as unknown as Context,
      'device',
      'dev-1'
    );

    // §10.4: `onDeviceCreated` is what recovers a user deleted inside Ringotel's 24-hour window
    // and creates a fresh one after it, so a restore goes through the same door a create does.
    expect(created.map(device => device.id)).toEqual(['dev-1']);
  });

  it('pushes nothing for a manual device', async () => {
    const db = await makeTestDb();
    await db
      .insertInto('devices')
      .values({
        id: 'dev-2',
        userId: 'owner',
        label: 'Desk',
        kind: 'manual',
        sipUsername: 'e101-dxyz',
        sipPasswordEnc: Buffer.from('enc'),
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .execute();

    await restoreProvisionedDevices(
      { db } as unknown as Context,
      'device',
      'dev-2'
    );

    expect(created).toHaveLength(0);
  });
});
