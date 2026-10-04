import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';

import { MS_PER_DAY, PROMPTS_SUBDIR, type Db } from '@zamfono/shared';

import { MOH_CLASSES_DIR } from './mohLayout.js';

// An upload is transcoded, and a recorded greeting written, before its row exists: a file this
// young may still be about to get one.
const MIN_ORPHAN_AGE_MS = MS_PER_DAY;

/** The names in `dir`, none for a directory that does not exist (a volume no audio reached yet). */
async function namesIn(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  });
}

/** Removes each of `names` in `dir` whose asset id (the name up to its first `.`) is not in
 * `known` and which was last changed before `before`; returns how many went. */
async function removeOrphans(
  dir: string,
  names: string[],
  known: ReadonlySet<string>,
  before: number
): Promise<number> {
  const removed = await Promise.all(
    names
      .filter(name => !known.has(name.split('.')[0] ?? name))
      .map(async name => {
        const entry = path.join(dir, name);
        const info = await stat(entry);
        if (info.mtimeMs >= before) {
          return false;
        }
        await rm(entry, { recursive: true, force: true });
        return true;
      })
  );
  return removed.filter(Boolean).length;
}

/**
 * Deletes the files and hold-music class directories under `prompts/` that no `audio_assets` row
 * names, soft-deleted rows included (§11.6): an upload or a recorded greeting whose row was never
 * written, or a purged asset whose files outlived it. Returns how many went.
 */
export async function deleteOrphanedAudioFiles(
  db: Db,
  now: string,
  mediaDir: string = env.MEDIA_DIR
): Promise<number> {
  const rows = await db.selectFrom('audioAssets').select('id').execute();
  const known = new Set(rows.map(row => row.id));
  const before = Date.parse(now) - MIN_ORPHAN_AGE_MS;
  const promptsDir = path.join(mediaDir, PROMPTS_SUBDIR);
  const classesDir = path.join(mediaDir, MOH_CLASSES_DIR);
  const files = (await namesIn(promptsDir)).filter(
    name => name !== path.basename(classesDir)
  );
  const [flat, classes] = await Promise.all([
    removeOrphans(promptsDir, files, known, before),
    removeOrphans(classesDir, await namesIn(classesDir), known, before)
  ]);
  return flat + classes;
}
