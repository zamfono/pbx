import * as privateEnv from '$app/env/private';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MS_PER_DAY, MS_PER_HOUR, type Db } from '@zamfono/shared';

import { propagateConfig } from '#lib/server/propagation.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { installRingotelFake } from '#testing/ringotelFake.js';
import { asConfirmedRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../devices/index.js';
import '../users/index.js';
import './index.js';

const START = new Date('2026-06-01T12:00:00.000Z');

/** A user at `extension` with one `ringotel` device, created through the real operations. */
async function userWithRingotelDevice(
  db: Db,
  email: string,
  extension: string
): Promise<{ userId: string; deviceId: string }> {
  const created = (await runOperation(
    db,
    'users.create',
    { name: `User ${extension}`, email, extension },
    asConfirmedRun()
  )) as { user: { id: string } };
  const device = (await runOperation(
    db,
    'devices.create',
    { userId: created.user.id, label: 'App', kind: 'ringotel' },
    asConfirmedRun()
  )) as { device: { id: string } };
  return { userId: created.user.id, deviceId: device.device.id };
}

/** Undoes the latest live `operation` entry, as `POST /audit/{id}/undo` would (§5.8). */
async function undoLatest(
  db: Db,
  operation: string
): Promise<{ warnings?: string[] }> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .where('undoneAt', 'is', null)
    .orderBy('createdAt', 'desc')
    .executeTakeFirstOrThrow();
  return (await runOperation(
    db,
    'audit.undo',
    { id: entry.id },
    asConfirmedRun()
  )) as {
    warnings?: string[];
  };
}

// Whether the undo's configuration had reached Asterisk when a Ringotel call went out.
let propagated = false;
vi.mocked(propagateConfig).mockImplementation(() => {
  propagated = true;
  return Promise.resolve();
});

function advance(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  propagated = false;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('audit.undo of a Ringotel-provisioned deletion (§10.4)', () => {
  it('recovers the Ringotel user when a users.delete is undone within 24 hours', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();
    await userWithRingotelDevice(db, 'ben@x.test', '102');
    const { userId } = await userWithRingotelDevice(db, 'anna@x.test', '101');
    const remoteId = ringotel.users.find(user => user.extension === '101')?.id;

    await runOperation(db, 'users.delete', { id: userId }, asConfirmedRun());
    expect(ringotel.users.map(user => user.extension)).toEqual(['102']);
    advance(MS_PER_HOUR);
    const callsBeforeUndo = ringotel.calls.length;
    await undoLatest(db, 'users.delete');

    // recoverDeletedUser brings back the same Ringotel user, app logins included; a createUser
    // would have sent the person a new activation e-mail instead.
    const undoMethods = ringotel.calls
      .slice(callsBeforeUndo)
      .map(call => call.method);
    expect(undoMethods).toContain('recoverDeletedUser');
    expect(undoMethods).not.toContain('createUser');
    expect(ringotel.users.find(user => user.extension === '101')?.id).toBe(
      remoteId
    );
  });

  it("recovers the tenant's only Ringotel user, with the organization's own domain", async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();
    const { deviceId } = await userWithRingotelDevice(db, 'anna@x.test', '101');

    await runOperation(
      db,
      'devices.delete',
      { id: deviceId },
      asConfirmedRun()
    );
    expect(ringotel.users).toEqual([]);
    advance(MS_PER_HOUR);
    await undoLatest(db, 'devices.delete');

    const recovery = ringotel.calls.find(
      call => call.method === 'recoverDeletedUser'
    );
    expect(recovery?.params.domain).toBe('testco');
    expect(ringotel.users.map(user => user.extension)).toEqual(['101']);
  });

  it('creates a fresh Ringotel user when the deletion is undone after 24 hours', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();
    const { deviceId } = await userWithRingotelDevice(db, 'anna@x.test', '101');
    const remoteId = ringotel.users[0]?.id;

    await runOperation(
      db,
      'devices.delete',
      { id: deviceId },
      asConfirmedRun()
    );
    advance(MS_PER_DAY + MS_PER_HOUR);
    const callsBeforeUndo = ringotel.calls.length;
    await undoLatest(db, 'devices.delete');

    // Past Ringotel's window, recoverDeletedUser is no longer accepted; the person onboards again.
    const undoMethods = ringotel.calls
      .slice(callsBeforeUndo)
      .map(call => call.method);
    expect(undoMethods).toContain('createUser');
    expect(undoMethods).not.toContain('recoverDeletedUser');
    expect(ringotel.users).toHaveLength(1);
    expect(ringotel.users[0]?.id).not.toBe(remoteId);
  });

  it("creates, never recovers, a device added after its owner's deletion was undone", async () => {
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
      'users.delete',
      { id: created.user.id },
      asConfirmedRun()
    );
    await undoLatest(db, 'users.delete');
    advance(MS_PER_HOUR);

    await runOperation(
      db,
      'devices.create',
      { userId: created.user.id, label: 'App', kind: 'ringotel' },
      asConfirmedRun()
    );

    expect(ringotel.calls.map(call => call.method)).toContain('createUser');
    expect(ringotel.users.map(user => user.extension)).toEqual(['101']);
  });
  it('pushes the restored device once the undo propagated, auditing it as audit.undo', async () => {
    const db = await makeTestDb();
    await seedSettings(db, {
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    });
    const ringotel = installRingotelFake();
    const { deviceId } = await userWithRingotelDevice(db, 'anna@x.test', '101');
    await runOperation(
      db,
      'devices.delete',
      { id: deviceId },
      asConfirmedRun()
    );
    advance(MS_PER_HOUR);
    propagated = false;
    const fakeFetch = globalThis.fetch;
    const sentBeforePropagation: unknown[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (!propagated) {
        sentBeforePropagation.push(init?.body);
      }
      return fakeFetch(url, init);
    }) as typeof fetch;
    ringotel.failing.add('recoverDeletedUser');

    const output = await undoLatest(db, 'devices.delete');

    // §10.4: Ringotel registers the user against the PBX before it accepts it, which inside the
    // undo's transaction Asterisk could not answer yet.
    expect(sentBeforePropagation).toEqual([]);
    expect(output.warnings).toEqual([
      expect.stringMatching(
        /is restored, but it has no Ringotel user yet, but Ringotel refused it .*devices[.]rotate/u
      )
    ]);
    const row = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'ringotel.push')
      .where('entityId', '=', deviceId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.changesJson)).toEqual([
      { field: 'outcome', from: null, to: 'refused' },
      { field: 'trigger', from: null, to: 'audit.undo' },
      { field: 'reason', from: null, to: expect.any(String) as unknown }
    ]);
    const restored = await db
      .selectFrom('devices')
      .select('deletedAt')
      .where('id', '=', deviceId)
      .executeTakeFirstOrThrow();
    expect(restored.deletedAt).toBeNull();
  });
});
