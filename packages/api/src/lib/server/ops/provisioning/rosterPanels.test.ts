import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { installRingotelFake } from '$lib/server/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '$lib/server/secretbox.js';
import { makeTestDb } from '$lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../devices/index.js';
import '../users/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.com';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', confirm: true };
}

/** Seeds `settings` with a Ringotel API token, then runs the Ringotel setup. */
async function seedRingotel(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId,
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .execute();
  await runOperation(
    db,
    'provisioning.ringotelSetup',
    { domain: 'testco', region: '3', packageid: 1 },
    asRun()
  );
}

async function createUser(
  db: Db,
  name: string,
  extension: string
): Promise<string> {
  const { user } = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    { name, email: `${name.toLowerCase()}@x.test`, extension },
    asRun()
  );
  return user.id;
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
    const anna = await createUser(db, 'Anna', '101');
    const bob = await createUser(db, 'Bob', '102');
    const { device } = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId: bob, label: 'App', kind: 'ringotel' },
      asRun()
    );
    await runOperation(
      db,
      'devices.setBlf',
      { id: device.id, keys: ['101'] },
      asRun()
    );

    await runOperation(
      db,
      'users.update',
      { id: anna, extension: '105', name: 'Anna Huber' },
      asRun()
    );

    const bobRemote = ringotel.users.find(user => user.extension === '102');
    expect(bobRemote?.options).toEqual({
      blfs: [{ number: '105', title: 'Anna Huber' }]
    });
  });
});
