import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db, type ReloadKind } from '@zamfono/shared';

import { deleteAudioFile, storeAudio } from '#lib/server/audio/types.js';
import { makeTestDb } from '#lib/server/testDb.js';

import '../ringGroups/index.js';

import { onPropagate, runOperation, type RunInput } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import './index.js';

vi.mock('#lib/server/audio/types.js', () => ({
  storeAudio: vi.fn(async (kind: string, upload: { filename: string }) =>
    Promise.resolve({ id: newId(), filename: `${kind}-${upload.filename}.wav` })
  ),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton and its main DID, required by ring-group creation. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId
    })
    .execute();
}

const upload = {
  filename: 'greeting.wav',
  mimeType: 'audio/wav',
  data: Buffer.from('x')
};

describe('audio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create stores the upload through storeAudio and rows it under the returned id', async () => {
    const db = await makeTestDb();
    const asset = await runOperation<unknown, { id: string; filename: string }>(
      db,
      'audio.create',
      { kind: 'greeting', label: 'Main greeting', upload },
      asRun()
    );
    const row = await db
      .selectFrom('audioAssets')
      .selectAll()
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row.filename).toBe(asset.filename);
    expect(row.label).toBe('Main greeting');
  });

  it('refuses an upload of a type other than WAV or MP3 as invalid input, storing nothing (§10.2)', async () => {
    const db = await makeTestDb();
    const attempt = runOperation(
      db,
      'audio.create',
      {
        kind: 'greeting',
        label: 'Main greeting',
        upload: { ...upload, mimeType: 'application/octet-stream' }
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
    expect(storeAudio).not.toHaveBeenCalled();
  });

  it('accepts an MP3 upload and a WAV type in any case', async () => {
    const db = await makeTestDb();
    for (const mimeType of ['audio/mpeg', 'Audio/WAV']) {
      // eslint-disable-next-line no-await-in-loop -- one upload after the other
      await runOperation(
        db,
        'audio.create',
        {
          kind: 'greeting',
          label: mimeType,
          upload: { ...upload, filename: `${mimeType}.upload`, mimeType }
        },
        asRun()
      );
    }
    expect(storeAudio).toHaveBeenCalledTimes(2);
  });

  it('deletes the stored file when the audioAssets insert fails', async () => {
    const db = await makeTestDb();
    const fixedId = newId();
    vi.mocked(storeAudio).mockResolvedValueOnce({
      id: fixedId,
      filename: 'greeting-clash.wav'
    });
    await db
      .insertInto('audioAssets')
      .values({
        id: fixedId,
        label: 'Existing',
        kind: 'greeting',
        filename: 'existing.wav',
        uploadedBy: 'owner',
        createdAt: nowIso()
      })
      .execute();
    const attempt = runOperation(
      db,
      'audio.create',
      { kind: 'greeting', label: 'Main greeting', upload },
      asRun()
    );
    await expect(attempt).rejects.toThrow();
    expect(deleteAudioFile).toHaveBeenCalledWith('greeting-clash.wav');
  });

  it('create propagates moh only for a moh-kind asset', async () => {
    const db = await makeTestDb();
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    await runOperation(
      db,
      'audio.create',
      { kind: 'greeting', label: 'Greeting', upload },
      asRun()
    );
    await runOperation(
      db,
      'audio.create',
      { kind: 'moh', label: 'Hold music', upload },
      asRun()
    );
    expect(propagated).toEqual([{ operation: 'audio.create', kind: ['moh'] }]);
  });

  it('delete propagates moh only for a moh-kind asset', async () => {
    const db = await makeTestDb();
    const greeting = await runOperation<unknown, { id: string }>(
      db,
      'audio.create',
      { kind: 'greeting', label: 'Greeting', upload },
      asRun()
    );
    const moh = await runOperation<unknown, { id: string }>(
      db,
      'audio.create',
      { kind: 'moh', label: 'Hold music', upload },
      asRun()
    );
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    await runOperation(
      db,
      'audio.delete',
      { id: greeting.id },
      asRun({ confirm: true })
    );
    await runOperation(
      db,
      'audio.delete',
      { id: moh.id },
      asRun({ confirm: true })
    );
    expect(propagated).toEqual([{ operation: 'audio.delete', kind: ['moh'] }]);
  });

  it('allows deleting an audio asset whose announcement forward_targets row is an orphan no owner references', async () => {
    const db = await makeTestDb();
    const asset = await runOperation<unknown, { id: string }>(
      db,
      'audio.create',
      { kind: 'announcement', label: 'Orphaned', upload },
      asRun()
    );
    await db
      .insertInto('forwardTargets')
      .values({
        id: newId(),
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: asset.id,
        menuId: null
      })
      .execute();
    await expect(
      runOperation(
        db,
        'audio.delete',
        { id: asset.id },
        asRun({ confirm: true })
      )
    ).resolves.toMatchObject({ id: asset.id });
  });

  it('refuses to delete an audio asset a DID still reaches through its announcement target, with a Conflict', async () => {
    const db = await makeTestDb();
    const asset = await runOperation<unknown, { id: string }>(
      db,
      'audio.create',
      { kind: 'announcement', label: 'Welcome', upload },
      asRun()
    );
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: targetId,
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: asset.id,
        menuId: null
      })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: newId(),
        number: '+491234567',
        label: 'Main line',
        targetId,
        createdAt: nowIso()
      })
      .execute();
    const attempt = runOperation(
      db,
      'audio.delete',
      { id: asset.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest types expect.any() as `any`
      references: [{ kind: 'did', id: expect.any(String), label: 'Main line' }]
    });
  });

  it('refuses to delete an audio asset an out-of-office rule still announces, with a Conflict', async () => {
    const db = await makeTestDb();
    const asset = await runOperation<unknown, { id: string }>(
      db,
      'audio.create',
      { kind: 'announcement', label: 'Away message', upload },
      asRun()
    );
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: targetId,
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: asset.id,
        menuId: null
      })
      .execute();
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: null,
        scopeRingGroupId: null,
        scopeMenuId: null,
        targetId,
        createdAt: nowIso()
      })
      .execute();
    const attempt = runOperation(
      db,
      'audio.delete',
      { id: asset.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      references: [
        {
          kind: 'oooRule',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest types expect.any() as `any`
          id: expect.any(String),
          label: 'out-of-office rule'
        }
      ]
    });
  });

  it('refuses to delete an audio asset a ring group still uses as its greeting, with a Conflict', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const asset = await runOperation<unknown, { id: string }>(
      db,
      'audio.create',
      { kind: 'greeting', label: 'Main greeting', upload },
      asRun()
    );
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous', greetingAudioId: asset.id },
      asRun()
    );
    const attempt = runOperation(
      db,
      'audio.delete',
      { id: asset.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'ringGroup', id: group.id, label: 'Support' }]
    });
  });
});
