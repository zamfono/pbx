import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';

import {
  installRingotelFake,
  type RingotelFake
} from '../provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '../secretbox.js';
import { asConfirmedRun, makeTestDb, seedSettings } from '../testDb.js';
import { runOperation } from './runner.js';

import './audit/index.js';
import './devices/index.js';
import './parking/index.js';
import './ringGroups/index.js';
import './users/index.js';

/** The branch's colleague roster as Ringotel last received it (§10.4 "Colleague presence"). */
function roster(ringotel: RingotelFake): { number: string; title: string }[] {
  return (ringotel.branchProvision?.blfs ?? []) as {
    number: string;
    title: string;
  }[];
}

async function undoLatest(db: Db, operation: string): Promise<void> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .where('undoneAt', 'is', null)
    .orderBy('createdAt', 'desc')
    .executeTakeFirstOrThrow();
  await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the Ringotel roster follows every user and extension change (§10.4)', () => {
  it('users.create, users.delete and its undo', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();

    const created = (await runOperation(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
      asConfirmedRun()
    )) as { user: { id: string } };
    expect(roster(ringotel)).toEqual([{ number: '101', title: 'Anna Huber' }]);

    await runOperation(
      db,
      'users.delete',
      { id: created.user.id },
      asConfirmedRun()
    );
    expect(roster(ringotel)).toEqual([]);

    await undoLatest(db, 'users.delete');
    expect(roster(ringotel)).toEqual([{ number: '101', title: 'Anna Huber' }]);

    // Undoing the creation deletes the user again, through users.delete.
    await undoLatest(db, 'users.create');
    expect(roster(ringotel)).toEqual([]);
  });

  it("users.update carries a new name and e-mail to the person's Ringotel user", async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();
    const created = (await runOperation(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
      asConfirmedRun()
    )) as { user: { id: string } };
    await runOperation(
      db,
      'devices.create',
      { userId: created.user.id, label: 'App', kind: 'ringotel' },
      asConfirmedRun()
    );

    await runOperation(
      db,
      'users.update',
      { id: created.user.id, name: 'Anna Berger' },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'users.update',
      { id: created.user.id, email: 'anna.berger@x.test' },
      asConfirmedRun()
    );

    expect(ringotel.users).toMatchObject([
      { extension: '101', name: 'Anna Berger', email: 'anna.berger@x.test' }
    ]);
  });

  it('ringGroups.create, a rename, ringGroups.delete and its undo', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();

    const group = (await runOperation(
      db,
      'ringGroups.create',
      { name: 'Sales', strategy: 'simultaneous' },
      asConfirmedRun()
    )) as { id: string; ext: string };
    expect(roster(ringotel)).toEqual([{ number: group.ext, title: 'Sales' }]);

    await runOperation(
      db,
      'ringGroups.update',
      { id: group.id, name: 'Sales DE' },
      asConfirmedRun()
    );
    expect(roster(ringotel)).toEqual([
      { number: group.ext, title: 'Sales DE' }
    ]);

    await runOperation(
      db,
      'ringGroups.delete',
      { id: group.id },
      asConfirmedRun()
    );
    expect(roster(ringotel)).toEqual([]);

    await undoLatest(db, 'ringGroups.delete');
    expect(roster(ringotel)).toEqual([
      { number: group.ext, title: 'Sales DE' }
    ]);
  });

  it('parking.set moves the slots, which the roster leaves to callpark.slots', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();

    await runOperation(
      db,
      'parking.set',
      { slots: ['701', '702'] },
      asConfirmedRun()
    );

    // The branch `blfs` list is every user and group extension (§11.2 `device_blf_keys`).
    expect(roster(ringotel)).toEqual([]);
    expect(ringotel.branchProvision?.callpark).toMatchObject({
      slots: [
        { alias: 'Parking 701', slot: '701' },
        { alias: 'Parking 702', slot: '702' }
      ]
    });
  });
});
