import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { createUser } from '#testing/fixtures.js';
import { installRingotelFake } from '#testing/ringotelFake.js';
import { asConfirmedRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../devices/index.js';
import '../users/index.js';
import './index.js';

/** Seeds `settings` with a Ringotel API token, then runs the Ringotel setup. */
async function seedRingotel(db: Db): Promise<void> {
  await seedSettings(db, {
    ringotelApiTokenEnc: encrypt(
      keyringFromEnv(privateEnv),
      'settings.ringotelApiTokenEnc',
      'ringotel-key'
    )
  });
  await runOperation(
    db,
    'provisioning.ringotelSetup',
    { domain: 'testco', region: '3', packageid: 1 },
    asConfirmedRun()
  );
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the Ringotel roster push re-renders the per-user panels (§10.4)', () => {
  it("shows a watched colleague's renamed extension and name on the watcher's panel", async () => {
    const db = await makeTestDb();
    const ringotel = installRingotelFake([]);
    await seedRingotel(db);
    const anna = await createUser(db, '101', {
      name: 'Anna',
      email: 'anna@x.test'
    });
    const bob = await createUser(db, '102', {
      name: 'Bob',
      email: 'bob@x.test'
    });
    const { device } = (await runOperation(
      db,
      'devices.create',
      { userId: bob, label: 'App', kind: 'ringotel' },
      asConfirmedRun()
    )) as { device: { id: string } };
    await runOperation(
      db,
      'devices.setBlf',
      { id: device.id, keys: ['101'] },
      asConfirmedRun()
    );

    await runOperation(
      db,
      'users.update',
      { id: anna, extension: '105', name: 'Anna Huber' },
      asConfirmedRun()
    );

    const bobRemote = ringotel.users.find(user => user.extension === '102');
    expect(bobRemote?.options).toEqual({
      blfs: [{ number: '105', title: 'Anna Huber' }]
    });
  });
});
