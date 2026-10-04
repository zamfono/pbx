import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { MS_PER_DAY, newId, nowIso } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { deleteOrphanedAudioFiles } from './orphans.js';

const TWO_DAYS_AGO = new Date(Date.now() - 2 * MS_PER_DAY);

async function exists(entry: string): Promise<boolean> {
  return stat(entry).then(
    () => true,
    () => false
  );
}

/** Writes `file`, it and its directory last changed `at`. */
async function place(file: string, at: Date): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'audio-bytes');
  await utimes(file, at, at);
  await utimes(path.dirname(file), at, at);
}

async function tempMediaDir(): Promise<string> {
  const mediaDir = await mkdtemp(path.join(tmpdir(), 'zamfono-orphans-'));
  onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
  return mediaDir;
}

describe('deleteOrphanedAudioFiles', () => {
  it('deletes the old prompts files and hold-music classes no audio asset names, and keeps the rest', async () => {
    const mediaDir = await tempMediaDir();
    const prompts = path.join(mediaDir, 'prompts');
    const db = await migratedTestDb();
    const known = newId();
    const softDeleted = newId();
    await db
      .insertInto('audioAssets')
      .values([
        {
          id: known,
          kind: 'moh',
          label: 'Kept',
          filename: `${known}.wav`,
          createdAt: nowIso()
        },
        {
          id: softDeleted,
          kind: 'greeting',
          label: 'Undoable',
          filename: `${softDeleted}.wav16`,
          createdAt: nowIso(),
          deletedAt: nowIso()
        }
      ])
      .execute();
    const orphan = newId();
    const fresh = path.join(prompts, `${newId()}.wav16`);
    const keptOld = [
      path.join(prompts, `${known}.wav`),
      path.join(prompts, 'moh', known, 'track.wav'),
      path.join(prompts, `${softDeleted}.wav16`),
      path.join(prompts, `${softDeleted}.master.mp3`)
    ];
    const goneFiles = [
      path.join(prompts, `${orphan}.wav16`),
      path.join(prompts, `${orphan}.master.mp3`),
      path.join(prompts, 'moh', orphan, 'track.wav')
    ];
    // Directories first, so a file placed later does not bump an old directory's time.
    await mkdir(path.join(prompts, 'moh', known), { recursive: true });
    await mkdir(path.join(prompts, 'moh', orphan), { recursive: true });
    await Promise.all(
      [...keptOld, ...goneFiles].map(file => place(file, TWO_DAYS_AGO))
    );
    await writeFile(fresh, 'audio-bytes');

    const removed = await deleteOrphanedAudioFiles(db, nowIso(), mediaDir);

    expect(removed).toBe(goneFiles.length);
    const kept = [...keptOld, fresh];
    const gone = [...goneFiles, path.join(prompts, 'moh', orphan)];
    expect(await Promise.all(kept.map(exists))).toEqual(kept.map(() => true));
    expect(await Promise.all(gone.map(exists))).toEqual(gone.map(() => false));
  });

  it('finds nothing on a volume no audio reached yet', async () => {
    const mediaDir = await tempMediaDir();
    const db = await migratedTestDb();

    expect(await deleteOrphanedAudioFiles(db, nowIso(), mediaDir)).toBe(0);
  });
});
