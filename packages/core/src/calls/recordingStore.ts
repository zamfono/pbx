/**
 * A stopped participation's files (§10.2 "Call recording", §11.6): its two raw per-leg files
 * mixed into the stereo file, stored as a `recordings` row and then removed. Its own module so
 * `recording.ts`, which tracks the participations, stays under the repository's `max-lines` lint
 * rule.
 */
import { rm } from 'node:fs/promises';

import type { Db } from '@zamfono/shared';

import type { Logger } from '../ari/types.js';
import type { Mixer } from './recordingMix.js';

export type StoreDeps = {
  db: Db;
  mix: Mixer;
  log: Logger;
  now: () => string;
};

/** A stopped participation: its id, whose it was, and where its files live. */
export type StoppedParticipation = {
  id: string;
  callId: string;
  userId: string | null;
  leftPath: string;
  rightPath: string;
  outPath: string;
};

/** Mixes `participation`'s raw pair and resolves with the mix's length in seconds, or `null` for a
 * failed mix, which it logs. */
async function mixedDurationS(
  deps: StoreDeps,
  participation: StoppedParticipation
): Promise<number | null> {
  try {
    return await deps.mix(
      participation.leftPath,
      participation.rightPath,
      participation.outPath
    );
  } catch (error) {
    deps.log.error(
      {
        error,
        callId: participation.callId,
        recordingId: participation.id
      },
      'recording mix failed; raw files kept for manual salvage'
    );
    return null;
  }
}

/**
 * Mixes `participation`'s raw pair, inserts its `recordings` row, lasting as long as the mixed file
 * does, and removes the raw pair: §10.2 keeps it only after a failed mix, and recordings are
 * personal data (§11.6). Returns false on a mix failure, which keeps the raw files for manual
 * salvage, writes no row (§10.2 "A `recordings` row asserts that a playable file exists")
 * and never touches the call itself.
 */
export async function storeParticipation(
  deps: StoreDeps,
  participation: StoppedParticipation
): Promise<boolean> {
  const mixedS = await mixedDurationS(deps, participation);
  if (mixedS === null) {
    return false;
  }
  await deps.db
    .insertInto('recordings')
    .values({
      id: participation.id,
      callId: participation.callId,
      userId: participation.userId,
      filename: `${participation.id}.wav`,
      durationS: Math.round(mixedS),
      createdAt: deps.now()
    })
    .execute();
  await Promise.all(
    [participation.leftPath, participation.rightPath].map(file =>
      rm(file, { force: true }).catch((error: unknown) => {
        // The recording itself is stored; the retention sweep removes a raw file left behind.
        deps.log.warn(
          {
            error,
            callId: participation.callId,
            recordingId: participation.id,
            file
          },
          'recording raw file could not be removed'
        );
      })
    )
  );
  return true;
}
