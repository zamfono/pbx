import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from './runner.js';

import './audio/index.js';
import './dids/index.js';

async function seedAnnouncement(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: 'Welcome',
      kind: 'announcement',
      filename: `${id}.wav`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function createDid(
  db: Db,
  number: string,
  target: Record<string, unknown>
): Promise<{ id: string; target: unknown }> {
  return runOperation(
    db,
    'dids.create',
    { number, target },
    asRun()
  ) as Promise<{ id: string; target: unknown }>;
}

// §10.1 step 7, §11.2 `forward_targets`: any target may play an announcement first, and `hangup`
// ends the call.
describe("a forward target's announcement and the hangup kind", () => {
  it('stores an announcement on a target of any kind, fallbacks included, and reads it back', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAnnouncement(db);
    const did = await createDid(db, '+4312345', {
      kind: 'external',
      external: '+4366412345',
      announcementAudioId: audioId,
      fallback: {
        kind: 'mailboxUser',
        userId: 'owner',
        announcementAudioId: audioId
      }
    });
    expect(did.target).toEqual({
      kind: 'external',
      external: '+4366412345',
      ringTimeoutS: null,
      record: false,
      afterCall: null,
      announcementAudioId: audioId,
      fallback: {
        kind: 'mailboxUser',
        userId: 'owner',
        announcementAudioId: audioId
      }
    });
  });

  it('stores hangup as a row with no target, with or without an announcement', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAnnouncement(db);
    const silent = await createDid(db, '+4312345', { kind: 'hangup' });
    expect(silent.target).toEqual({
      kind: 'hangup',
      announcementAudioId: null
    });
    const announced = await createDid(db, '+4312346', {
      kind: 'hangup',
      announcementAudioId: audioId
    });
    expect(announced.target).toEqual({
      kind: 'hangup',
      announcementAudioId: audioId
    });
    const rows = await db
      .selectFrom('dids')
      .innerJoin('forwardTargets', 'forwardTargets.id', 'dids.targetId')
      .select([
        'forwardTargets.announcementAudioId',
        'forwardTargets.userId',
        'forwardTargets.external',
        'forwardTargets.menuId'
      ])
      .where('dids.number', 'in', ['+4312345', '+4312346'])
      .orderBy('dids.number')
      .execute();
    expect(rows).toEqual([
      { announcementAudioId: null, userId: null, external: null, menuId: null },
      {
        announcementAudioId: audioId,
        userId: null,
        external: null,
        menuId: null
      }
    ]);
  });

  it('refuses the former announcement kind and an unknown asset', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAnnouncement(db);
    await expect(
      createDid(db, '+4312345', { kind: 'announcement', audioId })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createDid(db, '+4312345', {
        kind: 'user',
        userId: 'owner',
        announcementAudioId: 'missing'
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to delete an asset a target of any kind still announces', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAnnouncement(db);
    await createDid(db, '+4312345', {
      kind: 'user',
      userId: 'owner',
      announcementAudioId: audioId
    });
    await expect(
      runOperation(db, 'audio.delete', { id: audioId }, asRun())
    ).rejects.toMatchObject({ status: 409 });
  });
});
