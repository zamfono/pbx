import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { audioReferenceQueries } from './audioReferences.js';
import type { Db } from './db.js';
import { PROMPTS_SUBDIR } from './stackPaths.js';

/**
 * Hard-deletes a mailbox greeting that a new one replaced or a clear removed (§5.9, §10.2
 * "Mailbox access"): greetings are outside the audit log, so nothing could undo it. Only a
 * `vmGreeting` asset that no live row references any more goes: one shared with another mailbox
 * or used elsewhere stays. Runs in the transaction that repointed `mailbox_audio_id`; returns the
 * deleted asset's id, whose files the caller removes once that transaction has committed
 * (`deletePromptFiles`), or `null`.
 */
export async function retireGreeting(
  db: Db,
  audioId: string | null
): Promise<string | null> {
  if (audioId === null) {
    return null;
  }
  const deleted = await db
    .deleteFrom('audioAssets')
    .where('id', '=', audioId)
    .where('kind', '=', 'vmGreeting')
    .where(eb =>
      eb.not(
        eb.or(
          Object.values(audioReferenceQueries(db, audioId)).map(query =>
            eb.exists(query)
          )
        )
      )
    )
    .executeTakeFirst();
  return Number(deleted.numDeletedRows) > 0 ? audioId : null;
}

/**
 * Removes audio asset `id`'s files directly under `<mediaDir>/prompts/` (§11.6): its playback
 * WAV and an upload's master, each named `<id>.<extension>`. A file it misses has no row left,
 * so the purge's orphan sweep takes it.
 */
export async function deletePromptFiles(
  mediaDir: string,
  id: string
): Promise<void> {
  const promptsDir = path.join(mediaDir, PROMPTS_SUBDIR);
  const entries = await readdir(promptsDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter(entry => entry.startsWith(`${id}.`))
      .map(entry => rm(path.join(promptsDir, entry), { force: true }))
  );
}
