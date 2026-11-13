import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { newId, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { storeAudio } from '#lib/server/audio/store.js';
import { propagateConfig } from '#lib/server/propagation.js';
import { handleRest } from '#lib/server/rest.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { OpError, type Actor } from '../types.js';

import './index.js';

// The personal voicemail greeting over the API (§10.2 "Mailbox access"): stored exactly as `*96`
// stores a recorded one, an `audio_assets` row of kind `vmGreeting` set as the user's
// `mailbox_audio_id`, and like it outside the audit log (§5.7).

vi.mock('#lib/server/audio/store.js', () => ({
  storeAudio: vi.fn(async () => {
    const id = newId();
    return Promise.resolve({ id, filename: `${id}.wav` });
  }),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };
const anna: Actor = { id: 'anna', name: 'Anna', role: 'user' };
const upload = {
  filename: 'hello.wav',
  mimeType: 'audio/wav',
  data: Buffer.from('audio-bytes')
};

async function seedUsers(db: Db): Promise<void> {
  await Promise.all(
    ['admin', 'anna', 'ben'].map(id =>
      seedUser(db, {
        id,
        name: id,
        email: `${id}@x.test`,
        role: id === 'admin' ? 'admin' : 'user'
      })
    )
  );
}

async function greetingOf(db: Db, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select('mailboxAudioId')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return row.mailboxAudioId;
}

async function assetIds(db: Db): Promise<string[]> {
  const rows = await db.selectFrom('audioAssets').select('id').execute();
  return rows.map(row => row.id);
}

/** A media volume of its own for the test, `MEDIA_DIR`; its `prompts/` directory. */
async function stubMediaDir(): Promise<string> {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-greeting-'));
  onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
  vi.stubEnv('MEDIA_DIR', mediaDir);
  const promptsDir = path.join(mediaDir, 'prompts');
  await mkdir(promptsDir);
  return promptsDir;
}

/** Writes greeting `id`'s playback WAV and master into `promptsDir`, as `storeAudio` does. */
async function writeGreetingFiles(
  promptsDir: string,
  id: string
): Promise<void> {
  await writeFile(path.join(promptsDir, `${id}.wav16`), 'wav');
  await writeFile(path.join(promptsDir, `${id}.master.mp3`), 'mp3');
}

function as(actor: Actor): RunInput {
  return { actor, channel: 'rest', requestId: 'req-1' };
}

describe('users.setVoicemailGreeting and users.clearVoicemailGreeting', () => {
  beforeEach(() => {
    vi.mocked(storeAudio).mockClear();
  });

  it("stores a user's own greeting as *96 does, outside the audit log, and makes core reload", async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    vi.mocked(propagateConfig).mockClear();

    const result = (await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'anna', upload },
      as(anna)
    )) as { mailboxAudioId: string };

    expect(storeAudio).toHaveBeenCalledWith('vmGreeting', upload);
    const asset = await db
      .selectFrom('audioAssets')
      .select(['id', 'kind', 'label', 'uploadedBy'])
      .executeTakeFirstOrThrow();
    expect(asset).toEqual({
      id: result.mailboxAudioId,
      kind: 'vmGreeting',
      label: 'Mailbox greeting',
      uploadedBy: 'anna'
    });
    await expect(greetingOf(db, 'anna')).resolves.toBe(asset.id);
    const audit = await db.selectFrom('auditLog').selectAll().execute();
    expect(audit).toEqual([]);
    expect(propagateConfig).toHaveBeenCalledOnce();
  });

  it("refuses a user setting or clearing another's greeting, and lets an admin do both", async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    await expect(
      runOperation(
        db,
        'users.setVoicemailGreeting',
        { id: 'ben', upload },
        as(anna)
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(storeAudio).not.toHaveBeenCalled();
    await expect(
      runOperation(
        db,
        'users.clearVoicemailGreeting',
        { id: 'ben' },
        { ...as(anna), confirm: true }
      )
    ).rejects.toMatchObject({ status: 403 });

    await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'ben', upload },
      as(admin)
    );
    await expect(greetingOf(db, 'ben')).resolves.not.toBeNull();
    await runOperation(
      db,
      'users.clearVoicemailGreeting',
      { id: 'ben' },
      { ...as(admin), confirm: true }
    );
    await expect(greetingOf(db, 'ben')).resolves.toBeNull();
  });

  it('refuses an upload other than WAV or MP3 as audio.create does', async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    await expect(
      runOperation(
        db,
        'users.setVoicemailGreeting',
        { id: 'anna', upload: { ...upload, mimeType: 'video/mp4' } },
        as(anna)
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(storeAudio).not.toHaveBeenCalled();
  });

  it('answers 507 while the media volume is at its limit, keeping the greeting it had (§11.6)', async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    vi.mocked(storeAudio).mockRejectedValueOnce(
      new OpError(507, 'upload: the media volume is at its limit')
    );
    await expect(
      runOperation(
        db,
        'users.setVoicemailGreeting',
        { id: 'anna', upload },
        as(anna)
      )
    ).rejects.toMatchObject({ status: 507 });
    await expect(greetingOf(db, 'anna')).resolves.toBeNull();
  });

  it('clears back to the default prompt only once confirmed, deleting the greeting and its files', async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    const promptsDir = await stubMediaDir();
    const first = (await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'anna', upload },
      as(anna)
    )) as { mailboxAudioId: string };
    await writeGreetingFiles(promptsDir, first.mailboxAudioId);
    await expect(
      runOperation(db, 'users.clearVoicemailGreeting', { id: 'anna' }, as(anna))
    ).rejects.toMatchObject({ status: 409 });
    await runOperation(
      db,
      'users.clearVoicemailGreeting',
      { id: 'anna' },
      { ...as(anna), confirm: true }
    );
    await expect(greetingOf(db, 'anna')).resolves.toBeNull();
    await expect(assetIds(db)).resolves.toEqual([]);
    await expect(readdir(promptsDir)).resolves.toEqual([]);
  });

  it('deletes the greeting a new one replaces at once, its row and its files', async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    const promptsDir = await stubMediaDir();
    const first = (await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'anna', upload },
      as(anna)
    )) as { mailboxAudioId: string };
    await writeGreetingFiles(promptsDir, first.mailboxAudioId);
    const second = (await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'anna', upload },
      as(anna)
    )) as { mailboxAudioId: string };
    await writeGreetingFiles(promptsDir, second.mailboxAudioId);
    await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'anna', upload },
      as(anna)
    );
    await expect(assetIds(db)).resolves.not.toContain(first.mailboxAudioId);
    await expect(assetIds(db)).resolves.not.toContain(second.mailboxAudioId);
    await expect(readdir(promptsDir)).resolves.toEqual([]);
  });

  it('keeps a replaced greeting, row and files, that another mailbox still uses', async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    const promptsDir = await stubMediaDir();
    const first = (await runOperation(
      db,
      'users.setVoicemailGreeting',
      { id: 'anna', upload },
      as(anna)
    )) as { mailboxAudioId: string };
    await writeGreetingFiles(promptsDir, first.mailboxAudioId);
    await db
      .updateTable('users')
      .set({ mailboxAudioId: first.mailboxAudioId })
      .where('id', '=', 'ben')
      .execute();
    await runOperation(
      db,
      'users.clearVoicemailGreeting',
      { id: 'anna' },
      { ...as(anna), confirm: true }
    );
    await expect(assetIds(db)).resolves.toEqual([first.mailboxAudioId]);
    await expect(readdir(promptsDir)).resolves.toHaveLength(2);
  });

  it('takes the upload as multipart form data on PUT /users/{id}/voicemailGreeting', async () => {
    const db = await makeTestDb();
    await seedUsers(db);
    const form = new FormData();
    form.set(
      'upload',
      new File([Buffer.from('audio-bytes')], 'hello.wav', { type: 'audio/wav' })
    );
    const response = await handleRest(
      new Request('http://api/api/v1/users/anna/voicemailGreeting', {
        method: 'PUT',
        body: form
      }),
      anna,
      { db, requestId: 'req-1' }
    );
    expect(response.status).toBe(200);
    await expect(greetingOf(db, 'anna')).resolves.not.toBeNull();
  });
});
