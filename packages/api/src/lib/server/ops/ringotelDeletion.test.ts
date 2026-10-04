import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db, UserRole } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import {
  installRingotelFake,
  type RingotelFake
} from '#testing/ringotelFake.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from './runner.js';

import './index.js';

const owner: RunInput = {
  actor: { id: 'owner', name: 'Owner', role: 'owner' },
  channel: 'rest',
  requestId: 'req-1',
  confirm: true
};

let fake: RingotelFake | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

/** A stack set up with the fake's Ringotel, user 998 with `role` and one `ringotel` device of theirs. */
async function ringotelDevice(
  role: UserRole = 'user'
): Promise<{ db: Db; userId: string; deviceId: string }> {
  const db = await makeTestDb();
  await seedSettings(db, {
    ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key'),
    ringotelOrgId: 'org-1',
    ringotelBranchId: 'branch-1'
  });
  fake = installRingotelFake();
  const userId = await seedUser(db, { ext: '998', role, passwordHash: 'x' });
  const created = (await runOperation(
    db,
    'devices.create',
    { userId, label: 'Phone', kind: 'ringotel' },
    owner
  )) as { device: { id: string } };
  return { db, userId, deviceId: created.device.id };
}

/** Runs `around` for each Ringotel request, given its method and the fake's answer to it. */
function aroundRingotel(
  around: (method: string, answer: () => Promise<Response>) => Promise<Response>
): void {
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const { method } = JSON.parse(init?.body as string) as { method: string };
    return around(method, () => fakeFetch(url, init));
  }) as typeof fetch;
}

describe("a deletion of a ringotel device's Ringotel user", () => {
  it('waits for a push of the device under way, which then cannot re-create the user', async () => {
    const { db, deviceId } = await ringotelDevice();
    const pushUnderWay = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let held = false;
    // The rotation's push looks the user up first; its answer comes once the deletion ran.
    aroundRingotel(async (method, answer) => {
      if (method === 'getUsers' && !held) {
        held = true;
        pushUnderWay.resolve(undefined);
        await release.promise;
      }
      return answer();
    });

    const rotating = runOperation(
      db,
      'devices.rotate',
      { id: deviceId },
      owner
    );
    await pushUnderWay.promise;
    const deleting = runOperation(
      db,
      'devices.delete',
      { id: deviceId },
      owner
    );
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    release.resolve(undefined);
    await Promise.all([rotating, deleting]);

    expect(fake?.users).toEqual([]);
  });

  it('is taken back when the deletion is refused after Ringotel deleted the user', async () => {
    const { db, userId } = await ringotelDevice('owner');
    // The other owner leaves while Ringotel deletes the user, so the deletion would remove the
    // last owner: refused in its transaction.
    aroundRingotel(async (method, answer) => {
      const answered = await answer();
      if (method === 'deleteUser') {
        await db
          .updateTable('users')
          .set({ role: 'admin' })
          .where('id', '=', 'owner')
          .execute();
      }
      return answered;
    });

    await expect(
      runOperation(db, 'users.delete', { id: userId }, owner)
    ).rejects.toThrow(/owner/u);

    expect(fake?.users).toHaveLength(1);
  });

  it('by an undo of the creation does not wait forever on a push under way', async () => {
    const { db, deviceId } = await ringotelDevice();
    const otherUser = await seedUser(db, { ext: '997', passwordHash: 'x' });
    const created = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'devices.create')
      .where('entityId', '=', deviceId)
      .executeTakeFirstOrThrow();
    const other = (await runOperation(
      db,
      'devices.create',
      { userId: otherUser, label: 'Tablet', kind: 'ringotel' },
      owner
    )) as { device: { id: string } };
    const pushUnderWay = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let held = false;
    aroundRingotel(async (method, answer) => {
      if (method === 'getUsers' && !held) {
        held = true;
        pushUnderWay.resolve(undefined);
        await release.promise;
      }
      return answer();
    });

    const rotating = runOperation(
      db,
      'devices.rotate',
      { id: other.device.id },
      owner
    );
    await pushUnderWay.promise;
    // The undo replays `devices.delete`, whose Ringotel call waits for the push's turn inside
    // the undo's transaction, while the push waits for that transaction to write its audit row.
    const undoing = runOperation(db, 'audit.undo', { id: created.id }, owner);
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    release.resolve(undefined);
    const outcome = await Promise.race([
      Promise.allSettled([rotating, undoing]).then(() => 'settled'),
      new Promise(resolve => {
        setTimeout(resolve, 2000, 'hung');
      })
    ]);

    expect(outcome).toBe('settled');
    await expect(undoing).resolves.toBeDefined();
  });

  it('of a user with none yet waits for a push under way, so a device created meanwhile goes with the user', async () => {
    const { db, deviceId } = await ringotelDevice();
    const otherUser = await seedUser(db, { ext: '997', passwordHash: 'x' });
    const pushUnderWay = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let held = false;
    aroundRingotel(async (method, answer) => {
      if (method === 'getUsers' && !held) {
        held = true;
        pushUnderWay.resolve(undefined);
        await release.promise;
      }
      return answer();
    });

    const rotating = runOperation(
      db,
      'devices.rotate',
      { id: deviceId },
      owner
    );
    await pushUnderWay.promise;
    let deleted = false;
    const deleting = runOperation(
      db,
      'users.delete',
      { id: otherUser },
      owner
    ).then(() => {
      deleted = true;
    });
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    const creating = runOperation(
      db,
      'devices.create',
      { userId: otherUser, label: 'Tablet', kind: 'ringotel' },
      owner
    );
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    const deletedWhilePushing = deleted;
    release.resolve(undefined);
    await Promise.all([rotating, deleting, creating]);

    expect(deletedWhilePushing).toBe(false);
    expect(fake?.users).toHaveLength(1);
  });
});
