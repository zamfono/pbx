import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceRow } from '#lib/server/provisioning/types.js';
import { makeTestDb } from '#lib/server/testDb.js';

import { newEffects } from '../effects.js';
import type { Context } from '../types.js';
import { restoreProvisionedDevices } from './restoreProvisioning.js';

const created: DeviceRow[] = [];

vi.mock('#lib/server/provisioning/index.js', () => ({
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

vi.mock('#lib/server/secretbox.js', () => ({
  keyringFromEnv: () => ({}),
  decrypt: () => Buffer.from('sip-secret')
}));

const actor = { id: 'owner', name: 'Owner', role: 'owner' };

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

    const ctx = {
      db,
      actor,
      channel: 'rest',
      effects: newEffects()
    } as unknown as Context;
    await restoreProvisionedDevices(ctx, 'device', 'dev-1');

    // Nothing reaches Ringotel inside the undo's transaction: the push waits until Asterisk
    // holds the restored endpoint (§10.4), as a creation's does.
    expect(created).toHaveLength(0);
    const hooks = ctx.effects.after;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.waitsForAsterisk).toBe(true);
    expect(await hooks[0]?.hook(db)).toBeNull();
    // §10.4: `onDeviceCreated` is what recovers a user deleted inside Ringotel's 24-hour window
    // and creates a fresh one after it, so a restore goes through the same door a create does.
    expect(created.map(device => device.id)).toEqual(['dev-1']);
    const row = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'ringotel.push')
      .where('entityId', '=', 'dev-1')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.changesJson)).toContainEqual({
      field: 'trigger',
      from: null,
      to: 'audit.undo'
    });
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

    const ctx = {
      db,
      actor,
      channel: 'rest',
      effects: newEffects()
    } as unknown as Context;
    await restoreProvisionedDevices(ctx, 'device', 'dev-2');

    expect(ctx.effects.after).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});
