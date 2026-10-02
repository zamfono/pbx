import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { CoreClient } from '#lib/server/coreClient.js';
import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';
import { setCoreClientForTest } from './_shared.js';

import './index.js';

const anna: Actor = { id: 'u1', name: 'Anna', role: 'user' };
const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** A `CoreClient` double whose methods reject unless `overrides` supplies one. */
function stubCoreClient(overrides: Partial<CoreClient>): CoreClient {
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error('not implemented in test stub'));
  return {
    configChanged: notImplemented,
    state: notImplemented,
    originate: notImplemented,
    transfer: notImplemented,
    pickup: notImplemented,
    hangup: notImplemented,
    park: notImplemented,
    parked: notImplemented,
    mwi: notImplemented,
    ...overrides
  };
}

async function seedUser(db: Db, id: string, name: string): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id,
      name,
      email: `${id}@x.test`,
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
}

async function seedRingGroup(db: Db, name: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({ id, name, strategy: 'simultaneous', createdAt: nowIso() })
    .execute();
  return id;
}

async function addRingGroupMember(
  db: Db,
  groupId: string,
  userId: string,
  position: number
): Promise<void> {
  await db
    .insertInto('ringGroupMembers')
    .values({ groupId, position, userId, userGroupId: null })
    .execute();
}

async function seedVoicemail(
  db: Db,
  fields: {
    id?: string;
    mailboxUserId?: string | null;
    mailboxRingGroupId?: string | null;
    filename?: string;
  }
): Promise<string> {
  const id = fields.id ?? newId();
  await db
    .insertInto('voicemails')
    .values({
      id,
      mailboxUserId: fields.mailboxUserId ?? null,
      mailboxRingGroupId: fields.mailboxRingGroupId ?? null,
      caller: '+491234',
      filename: fields.filename ?? `${id}.wav`,
      durationS: 10,
      read: 0,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

afterEach(() => {
  setCoreClientForTest(stubCoreClient({}));
});

describe('voicemails', () => {
  it("a user lists only their own and their groups' voicemails", async () => {
    const db = await makeTestDb();
    await seedUser(db, 'u1', 'Anna');
    await seedUser(db, 'u2', 'Ben');
    const groupId = await seedRingGroup(db, 'Sales');
    await addRingGroupMember(db, groupId, 'u1', 1);
    const ownId = await seedVoicemail(db, { mailboxUserId: 'u1' });
    const groupVmId = await seedVoicemail(db, { mailboxRingGroupId: groupId });
    const otherId = await seedVoicemail(db, { mailboxUserId: 'u2' });

    const asUser = await runOperation<unknown, { items: { id: string }[] }>(
      db,
      'voicemails.list',
      {},
      asRun({ actor: anna })
    );
    expect(new Set(asUser.items.map(item => item.id))).toEqual(
      new Set([ownId, groupVmId])
    );

    const asOwner = await runOperation<unknown, { items: { id: string }[] }>(
      db,
      'voicemails.list',
      {},
      asRun({ actor: owner })
    );
    expect(new Set(asOwner.items.map(item => item.id))).toEqual(
      new Set([ownId, groupVmId, otherId])
    );
  });

  it('markRead writes no audit row and triggers one mwi call', async () => {
    const db = await makeTestDb();
    await seedUser(db, 'u1', 'Anna');
    const vmId = await seedVoicemail(db, { mailboxUserId: 'u1' });
    const mwiCalls: string[] = [];
    setCoreClientForTest(
      stubCoreClient({
        mwi: mailbox => {
          mwiCalls.push(mailbox);
          return Promise.resolve();
        }
      })
    );

    const result = await runOperation<unknown, { id: string; read: boolean }>(
      db,
      'voicemails.markRead',
      { id: vmId, read: true },
      asRun({ actor: anna })
    );
    expect(result.read).toBe(true);
    expect(mwiCalls).toEqual(['user:u1']);

    const auditRows = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'voicemails.markRead')
      .execute();
    expect(auditRows).toHaveLength(0);
  });

  it('markRead succeeds when core refuses the mwi update', async () => {
    const db = await makeTestDb();
    await seedUser(db, 'u1', 'Anna');
    const vmId = await seedVoicemail(db, { mailboxUserId: 'u1' });
    setCoreClientForTest(
      stubCoreClient({ mwi: () => Promise.reject(new Error('core down')) })
    );

    const result = await runOperation<unknown, { id: string; read: boolean }>(
      db,
      'voicemails.markRead',
      { id: vmId, read: true },
      asRun({ actor: anna })
    );
    expect(result).toEqual({ id: vmId, read: true });
  });

  it('voicemails.delete removes file and row with undoable 0', async () => {
    const db = await makeTestDb();
    await seedUser(db, 'u1', 'Anna');
    const filename = 'vm-1.wav';
    const vmId = await seedVoicemail(db, {
      id: 'vm-1',
      mailboxUserId: 'u1',
      filename
    });
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-vm-'));
    await mkdir(path.join(mediaDir, 'voicemail'), { recursive: true });
    const filePath = path.join(mediaDir, 'voicemail', filename);
    await writeFile(filePath, 'audio-bytes');
    const previousMediaDir = process.env.MEDIA_DIR;
    process.env.MEDIA_DIR = mediaDir;
    try {
      await runOperation(
        db,
        'voicemails.delete',
        { id: vmId },
        asRun({ actor: anna, confirm: true })
      );
    } finally {
      if (previousMediaDir === undefined) {
        delete process.env.MEDIA_DIR;
      } else {
        process.env.MEDIA_DIR = previousMediaDir;
      }
    }

    await expect(access(filePath)).rejects.toThrow();
    const row = await db
      .selectFrom('voicemails')
      .selectAll()
      .where('id', '=', vmId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
    const auditRow = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'voicemails.delete')
      .executeTakeFirstOrThrow();
    expect(auditRow.undoable).toBe(0);
  });
});
