import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import {
  installRingotelFake,
  type RingotelFake
} from '../provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '../secretbox.js';
import { makeTestDb } from '../testDb.js';
import { runOperation, type RunInput } from './runner.js';
import { type Actor } from './types.js';

import './audit/index.js';
import './parking/index.js';
import './ringGroups/index.js';
import './users/index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.FQDN ??= 'pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', confirm: true };
}

/** Seeds `settings` already provisioned with Ringotel (`org-1`/`branch-1`, §10.4). */
async function seedTenant(db: Db): Promise<void> {
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
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    })
    .execute();
}

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
  await runOperation(db, 'audit.undo', { id: entry.id }, asRun());
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the Ringotel roster follows every user and extension change (§10.4)', () => {
  it('users.create, users.delete and its undo', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const ringotel = installRingotelFake();

    const created = (await runOperation(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
      asRun()
    )) as { user: { id: string } };
    expect(roster(ringotel)).toEqual([{ number: '101', title: 'Anna Huber' }]);

    await runOperation(db, 'users.delete', { id: created.user.id }, asRun());
    expect(roster(ringotel)).toEqual([]);

    await undoLatest(db, 'users.delete');
    expect(roster(ringotel)).toEqual([{ number: '101', title: 'Anna Huber' }]);

    // Undoing the creation deletes the user again, through users.delete.
    await undoLatest(db, 'users.create');
    expect(roster(ringotel)).toEqual([]);
  });

  it('ringGroups.create, a rename, ringGroups.delete and its undo', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const ringotel = installRingotelFake();

    const group = (await runOperation(
      db,
      'ringGroups.create',
      { name: 'Sales', strategy: 'simultaneous' },
      asRun()
    )) as { id: string; ext: string };
    expect(roster(ringotel)).toEqual([{ number: group.ext, title: 'Sales' }]);

    await runOperation(
      db,
      'ringGroups.update',
      { id: group.id, name: 'Sales DE' },
      asRun()
    );
    expect(roster(ringotel)).toEqual([
      { number: group.ext, title: 'Sales DE' }
    ]);

    await runOperation(db, 'ringGroups.delete', { id: group.id }, asRun());
    expect(roster(ringotel)).toEqual([]);

    await undoLatest(db, 'ringGroups.delete');
    expect(roster(ringotel)).toEqual([
      { number: group.ext, title: 'Sales DE' }
    ]);
  });

  it('parking.set moves the slots, which the roster leaves to callpark.slots', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const ringotel = installRingotelFake();

    await runOperation(db, 'parking.set', { slots: ['701', '702'] }, asRun());

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
