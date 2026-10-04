import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { asRun, makeTestDb, owner } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const anna: Actor = { id: 'u1', name: 'Anna', role: 'user' };

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
  vi.mocked(getCoreClient).mockReset();
});

describe('voicemails', () => {
  it("a user lists only their own and their groups' voicemails", async () => {
    const db = await makeTestDb();
    await seedUser(db, { id: 'u1', name: 'Anna' });
    await seedUser(db, { id: 'u2', name: 'Ben' });
    const groupId = await seedRingGroup(db, 'Sales');
    await addRingGroupMember(db, groupId, 'u1', 1);
    const ownId = await seedVoicemail(db, { mailboxUserId: 'u1' });
    const groupVmId = await seedVoicemail(db, { mailboxRingGroupId: groupId });
    const otherId = await seedVoicemail(db, { mailboxUserId: 'u2' });

    const asUser = (await runOperation(
      db,
      'voicemails.list',
      {},
      asRun({ actor: anna })
    )) as { items: { id: string }[] };
    expect(new Set(asUser.items.map(item => item.id))).toEqual(
      new Set([ownId, groupVmId])
    );

    const asOwner = (await runOperation(
      db,
      'voicemails.list',
      {},
      asRun({ actor: owner })
    )) as { items: { id: string }[] };
    expect(new Set(asOwner.items.map(item => item.id))).toEqual(
      new Set([ownId, groupVmId, otherId])
    );
  });

  it("refuses a user another's voicemail with 403 before asking to confirm its deletion", async () => {
    const db = await makeTestDb();
    await seedUser(db, { id: 'u1', name: 'Anna' });
    await seedUser(db, { id: 'u2', name: 'Ben' });
    const otherId = await seedVoicemail(db, { mailboxUserId: 'u2' });
    await expect(
      runOperation(
        db,
        'voicemails.delete',
        { id: otherId },
        asRun({ actor: anna })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('markRead writes no audit row and triggers one mwi call', async () => {
    const db = await makeTestDb();
    await seedUser(db, { id: 'u1', name: 'Anna' });
    const vmId = await seedVoicemail(db, { mailboxUserId: 'u1' });
    const mwiCalls: string[] = [];
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        mwi: mailbox => {
          mwiCalls.push(mailbox);
          return Promise.resolve();
        }
      })
    );

    const result = (await runOperation(
      db,
      'voicemails.markRead',
      { id: vmId, read: true },
      asRun({ actor: anna })
    )) as { id: string; read: boolean };
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
    await seedUser(db, { id: 'u1', name: 'Anna' });
    const vmId = await seedVoicemail(db, { mailboxUserId: 'u1' });
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({ mwi: () => Promise.reject(new Error('core down')) })
    );

    const result = (await runOperation(
      db,
      'voicemails.markRead',
      { id: vmId, read: true },
      asRun({ actor: anna })
    )) as { id: string; read: boolean };
    expect(result).toEqual({ id: vmId, read: true });
  });

  it('voicemails.delete removes file and row with undoable 0', async () => {
    const db = await makeTestDb();
    await seedUser(db, { id: 'u1', name: 'Anna' });
    const filename = 'vm-1.wav';
    const vmId = await seedVoicemail(db, {
      id: 'vm-1',
      mailboxUserId: 'u1',
      filename
    });
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-vm-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
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

  it('voicemails.delete keeps the file when the delete rolls back', async () => {
    const db = await makeTestDb();
    await seedUser(db, { id: 'u1', name: 'Anna' });
    const filename = 'vm-1.wav';
    const vmId = await seedVoicemail(db, {
      id: 'vm-1',
      mailboxUserId: 'u1',
      filename
    });
    await sql`
      CREATE TRIGGER voicemails_no_delete BEFORE DELETE ON voicemails
      BEGIN SELECT RAISE(ABORT, 'refused'); END
    `.execute(db);
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-vm-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    await mkdir(path.join(mediaDir, 'voicemail'), { recursive: true });
    const filePath = path.join(mediaDir, 'voicemail', filename);
    await writeFile(filePath, 'audio-bytes');
    vi.stubEnv('MEDIA_DIR', mediaDir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    await expect(
      runOperation(
        db,
        'voicemails.delete',
        { id: vmId },
        asRun({ actor: anna, confirm: true })
      )
    ).rejects.toThrow();

    await expect(access(filePath)).resolves.toBeUndefined();
  });
});
