import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import { buildBranchProvision, createRingotelProvider } from './ringotel.js';
import type { RingotelClient } from './ringotelClient.js';
import type { DeviceRow } from './types.js';

const NOW = '2026-06-01T12:00:00.000Z';

type RecordedCall = { method: string; params?: Record<string, unknown> };

/**
 * A `RingotelClient` stub recording every call and answering from `results` by method name;
 * `createUser` answers with the new user's id, as the Admin API does, unless overridden.
 */
function fakeClient(overrides: Record<string, unknown> = {}): {
  client: RingotelClient;
  calls: RecordedCall[];
} {
  const results: Record<string, unknown> = {
    createUser: { id: 'ru-new' },
    ...overrides
  };
  const calls: RecordedCall[] = [];
  const client: RingotelClient = {
    call: <T>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return Promise.resolve(results[method] as T);
    }
  };
  return { client, calls };
}

/** Seeds `settings` (already provisioned with Ringotel ids), one user with extension `101` and
 *  one parking slot at `701`. */
async function seed(db: Db): Promise<{ userId: string }> {
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
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelMaxRegs: 3
    })
    .execute();
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Anna Huber',
      email: 'anna@x.test',
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
  await db.insertInto('extensions').values({ ext: '101', userId }).execute();
  await db
    .insertInto('extensions')
    .values({ ext: '701', isParkingSlot: 1 })
    .execute();
  return { userId };
}

async function seedDevice(db: Db, userId: string): Promise<DeviceRow> {
  const id = newId();
  await db
    .insertInto('devices')
    .values({
      id,
      userId,
      label: "Anna's phone",
      kind: 'ringotel',
      transport: 'tls',
      sipUsername: 'e101-abcde',
      sipPasswordEnc: Buffer.from('unused'),
      createdAt: nowIso()
    })
    .execute();
  return db
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

describe('buildBranchProvision', () => {
  it('maps codecs to Ringotel names, drops g722, and carries the feature codes', () => {
    const provision = buildBranchProvision(
      {
        codecsJson: '["opus","g722","alaw"]',
        featureCodesJson:
          '{"pickup":"*8","dndOn":"*90","dndOff":"*91","mailbox":"*95","ownVoicemail":"*96","deposit":"*97","addParty":"*5","clirOn":"#31#","clirOff":"*31#","park":"*70"}',
        ringotelMaxRegs: 3
      },
      ['701'],
      [{ number: '101', title: 'Anna Huber' }]
    );

    expect(provision.protocol).toBe('sips');
    expect(provision.features).toBe('pbx');
    expect(provision.codecs).toEqual([
      { codec: 'Opus', frame: 20 },
      { codec: 'G.711 Alaw', frame: 20 }
    ]);
    expect(provision.dnd).toEqual({ on: '*90', off: '*91' });
    expect(provision.vmail.ext).toBe('*96');
    expect(provision.maxregs).toBe(3);
    expect(provision.blfs).toEqual([{ number: '101', title: 'Anna Huber' }]);
    expect(provision.callpark).toEqual({
      park: '*70',
      slots: [{ alias: 'Parking 701', slot: '701' }]
    });
  });

  it('routes every call through the PBX and lets its caller name win (§10.4)', () => {
    const provision = buildBranchProvision(
      {
        codecsJson: '["opus"]',
        featureCodesJson:
          '{"pickup":"*8","dndOn":"*90","dndOff":"*91","mailbox":"*95","ownVoicemail":"*96","deposit":"*97","addParty":"*5","clirOn":"#31#","clirOff":"*31#","park":"*70"}',
        ringotelMaxRegs: 3
      },
      [],
      []
    );

    expect(provision).toMatchObject({
      internalRouting: 1,
      extst: true,
      extvc: true,
      keepreg: true,
      keepCallerName: true,
      regexpires: 120,
      inboundFormat: '',
      displayname: ''
    });
    expect(provision).not.toHaveProperty('internal');
  });
});

describe('createRingotelProvider', () => {
  it('onDeviceCreated calls createUser with the extension, sip username and status 1', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const device = await seedDevice(db, userId);
    const { client, calls } = fakeClient();
    const provider = createRingotelProvider({ client, db, now: () => NOW });

    await provider.onDeviceCreated(device, {
      username: 'e101-abcde',
      password: 'p@ss1'
    });

    expect(calls).toEqual([
      {
        method: 'createUser',
        params: {
          orgid: 'org-1',
          branchid: 'branch-1',
          name: 'Anna Huber',
          email: 'anna@x.test',
          extension: '101',
          username: 'e101-abcde',
          authname: 'e101-abcde',
          password: 'p@ss1',
          status: 1
        }
      }
    ]);
  });

  it('onCredentialsRotated resolves the Ringotel id via getUsers, then updateUser', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const device = await seedDevice(db, userId);
    const { client, calls } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db });

    await provider.onCredentialsRotated(device, {
      username: 'e101-abcde',
      password: 'new-pw'
    });

    expect(calls).toEqual([
      { method: 'getUsers', params: { orgid: 'org-1', branchid: 'branch-1' } },
      {
        method: 'updateUser',
        params: { orgid: 'org-1', id: 'ru-1', password: 'new-pw' }
      }
    ]);
  });

  it('onDeviceBlfChanged pushes the panel as updateUser options.blfs', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const device = await seedDevice(db, userId);
    const { client, calls } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db });

    await provider.onDeviceBlfChanged?.(device, ['701']);

    expect(calls[1]).toEqual({
      method: 'updateUser',
      params: {
        orgid: 'org-1',
        id: 'ru-1',
        options: { blfs: [{ number: '701', title: 'Parking 701' }] }
      }
    });
  });

  it('onDeviceBlfChanged keeps the caller order, even against the extension sort order', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const device = await seedDevice(db, userId);
    const { client, calls } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db });

    await provider.onDeviceBlfChanged?.(device, ['701', '101']);

    expect(calls[1]).toEqual({
      method: 'updateUser',
      params: {
        orgid: 'org-1',
        id: 'ru-1',
        options: {
          blfs: [
            { number: '701', title: 'Parking 701' },
            { number: '101', title: 'Anna Huber' }
          ]
        }
      }
    });
  });

  it('onDeviceDeleted resolves the Ringotel id, then deleteUser', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const device = await seedDevice(db, userId);
    const { client, calls } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db });

    await provider.onDeviceDeleted(device);

    expect(calls[1]).toEqual({
      method: 'deleteUser',
      params: { orgid: 'org-1', id: 'ru-1' }
    });
  });

  it('onRosterChanged pushes updateBranch blfs, then updateUser extension, username and authname per roster user', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    // The renamed device's current sipUsername: an extension rename (users.update) renames it in
    // the same transaction before onRosterChanged runs, so the push must carry the new one.
    await seedDevice(db, userId);
    const { client, calls } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db });
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    await provider.onRosterChanged?.([user]);

    expect(calls[0]?.method).toBe('updateBranch');
    // User and group extensions only: parking slot 701 is the branch's `callpark.slots` (§10.4).
    expect((calls[0]?.params?.provision as { blfs: unknown }).blfs).toEqual([
      { number: '101', title: 'Anna Huber' }
    ]);
    expect(calls[2]).toEqual({
      method: 'updateUser',
      params: {
        orgid: 'org-1',
        id: 'ru-1',
        extension: '101',
        username: 'e101-abcde',
        authname: 'e101-abcde'
      }
    });
  });

  it('onRosterChanged omits username/authname for a user with no live ringotel device', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const { client, calls } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db });
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    await provider.onRosterChanged?.([user]);

    expect(calls[2]).toEqual({
      method: 'updateUser',
      params: { orgid: 'org-1', id: 'ru-1', extension: '101' }
    });
  });

  it('onTenantProfileChanged pushes updateBranch without wiping the colleague BLF roster', async () => {
    const db = await makeTestDb();
    await seed(db);
    const { client, calls } = fakeClient();
    const provider = createRingotelProvider({ client, db });
    const settings = await db
      .selectFrom('settings')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();

    await provider.onTenantProfileChanged?.(settings);

    expect(calls[0]?.method).toBe('updateBranch');
    const provision = calls[0]?.params?.provision as {
      maxregs: number;
      blfs: { number: string; title: string }[];
    };
    expect(provision.maxregs).toBe(3);
    expect(provision.blfs).toEqual([{ number: '101', title: 'Anna Huber' }]);
  });

  it('onTenantProfileChanged pushes updateOrganization with hidePassInEmail and the language', async () => {
    const db = await makeTestDb();
    await seed(db);
    const { client, calls } = fakeClient();
    const provider = createRingotelProvider({ client, db });
    const settings = await db
      .selectFrom('settings')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();

    await provider.onTenantProfileChanged?.(settings);

    expect(calls[1]).toEqual({
      method: 'updateOrganization',
      params: {
        id: 'org-1',
        params: { hidePassInEmail: true, lang: 'en' }
      }
    });
  });

  it('onPbxRestarted resets the registrations: updateBranch with the profile and rereg', async () => {
    const db = await makeTestDb();
    await seed(db);
    const { client, calls } = fakeClient();
    const provider = createRingotelProvider({ client, db });

    await provider.onPbxRestarted?.();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('updateBranch');
    expect(calls[0]?.params).toMatchObject({
      id: 'branch-1',
      orgid: 'org-1',
      rereg: true,
      provision: { internalRouting: 1, keepreg: true }
    });
  });

  it('returns the Ringotel user id it created or updated, for the audit entry', async () => {
    const db = await makeTestDb();
    const { userId } = await seed(db);
    const device = await seedDevice(db, userId);
    const { client } = fakeClient({
      getUsers: [{ id: 'ru-1', extension: '101' }]
    });
    const provider = createRingotelProvider({ client, db, now: () => NOW });

    await expect(
      provider.onDeviceCreated(device, {
        username: 'e101-abcde',
        password: 'p'
      })
    ).resolves.toEqual({ remoteId: 'ru-new' });
    await expect(
      provider.onCredentialsRotated(device, {
        username: 'e101-abcde',
        password: 'q'
      })
    ).resolves.toEqual({ remoteId: 'ru-1' });
  });
});
