import { describe, expect, it } from 'vitest';

import { newId, nowIso, type AudioKind, type Db } from '@zamfono/shared';

import { asRun, makeTestDb, seedSettings } from '#lib/server/testDb.js';

import '../menus/index.js';
import '../ringGroups/index.js';
import '../settings/index.js';
import '../users/index.js';

import { runOperation } from '../runner.js';

async function seedAudio(db: Db, kind: AudioKind): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: kind,
      kind,
      filename: `${id}.wav`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

const fallbackTarget = { kind: 'external', external: '+490000000' };

/** Each column referencing an audio asset, the kind §11.2 names for it, and an input setting it. */
const references: [string, AudioKind, string, (id: string) => object][] = [
  [
    'ring_groups.greeting_audio_id',
    'greeting',
    'ringGroups.create',
    id => ({ name: 'G', strategy: 'simultaneous', greetingAudioId: id })
  ],
  [
    'ring_groups.moh_audio_id',
    'moh',
    'ringGroups.create',
    id => ({ name: 'G', strategy: 'simultaneous', mohAudioId: id })
  ],
  [
    'ring_groups.mailbox_audio_id',
    'vmGreeting',
    'ringGroups.create',
    id => ({ name: 'G', strategy: 'simultaneous', mailboxAudioId: id })
  ],
  [
    'users.mailbox_audio_id',
    'vmGreeting',
    'users.update',
    id => ({ id: 'owner', mailboxAudioId: id })
  ],
  [
    'settings.hold_moh_audio_id',
    'moh',
    'settings.update',
    id => ({ holdMohAudioId: id })
  ],
  [
    'menus.audio_id',
    'announcement',
    'menus.create',
    id => ({ name: 'M', audioId: id, fallbackTarget })
  ],
  [
    'forward_targets.announcement_audio_id',
    'announcement',
    'settings.update',
    id => ({ fallbackTarget: { kind: 'announcement', audioId: id } })
  ]
];

describe('audio kind of a reference (§11.2)', () => {
  it.each(references)(
    '%s accepts an asset of kind %s and refuses another kind with a 422',
    async (_column, kind, op, input) => {
      const db = await makeTestDb();
      await seedSettings(db);
      await db
        .insertInto('extensions')
        .values({ ext: '100', userId: 'owner' })
        .execute();
      const other = kind === 'moh' ? 'greeting' : 'moh';
      const wrong = runOperation(
        db,
        op,
        input(await seedAudio(db, other)),
        asRun()
      );
      await expect(wrong).rejects.toMatchObject({ status: 422 });
      await expect(
        runOperation(db, op, input(await seedAudio(db, kind)), asRun())
      ).resolves.toBeDefined();
    }
  );

  it('answers an unknown asset with a 404', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const attempt = runOperation(
      db,
      'settings.update',
      { holdMohAudioId: 'missing' },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });
});
