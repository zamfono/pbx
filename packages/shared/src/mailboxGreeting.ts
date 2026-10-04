import { audioReferenceQueries } from './audioReferences.js';
import type { Db } from './db.js';

/**
 * Soft-deletes a mailbox greeting that a new one replaced or a clear removed (§10.2 "Mailbox
 * access"), so the daily purge removes its row and file (§5.9). Only a `vmGreeting` asset that no
 * live row references any more goes: one shared with another mailbox or used elsewhere stays.
 * Runs in the transaction that repointed `mailbox_audio_id`.
 */
export async function retireGreeting(
  db: Db,
  audioId: string | null,
  now: string
): Promise<void> {
  if (audioId === null) {
    return;
  }
  await db
    .updateTable('audioAssets')
    .set({ deletedAt: now })
    .where('id', '=', audioId)
    .where('kind', '=', 'vmGreeting')
    .where('deletedAt', 'is', null)
    .where(eb =>
      eb.not(
        eb.or(
          Object.values(audioReferenceQueries(db, audioId)).map(query =>
            eb.exists(query)
          )
        )
      )
    )
    .execute();
}
