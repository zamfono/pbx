import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  AUDIO_KINDS,
  audioReferenceQueries,
  HTTP_UNPROCESSABLE_CONTENT,
  type AudioKind,
  type DB,
  type Db
} from '@zamfono/shared';

import { deleteAudioFile, storeAudio } from '#lib/server/audio/store.js';
import type { AudioUpload, StoredAudio } from '#lib/server/audio/types.js';

import { findForwardTargetOwners } from '../forwardTargetOwners.js';
import { onRollback } from '../rollbackHooks.js';
import { liveRow } from '../rows.js';
import { OpError, type Context } from '../types.js';

/** An `audio_assets` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type AudioAssetRow = Selectable<DB['audioAssets']>;

/** Loads a live audio asset by id, or throws `OpError(404)`. */
export async function liveAudioAsset(
  db: Db,
  id: string
): Promise<AudioAssetRow> {
  return liveRow(db, 'audioAssets', id, `audio asset '${id}' not found`);
}

/**
 * Transcodes and stores `upload` (`storeAudio`), an operation's `prepare`: the file is deleted
 * again should the transaction that rows it not commit.
 */
export async function storeUpload(
  ctx: Pick<Context, 'effects'>,
  kind: AudioKind,
  upload: AudioUpload
): Promise<StoredAudio> {
  const stored = await storeAudio(kind, upload);
  onRollback(ctx, () => deleteAudioFile(stored.filename));
  return stored;
}

/** An audio asset's wire shape (§10.3 "Audio"). */
export const audioAssetOut = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(AUDIO_KINDS),
  filename: z.string(),
  createdAt: z.string()
});
export type AudioAssetOut = z.infer<typeof audioAssetOut>;

export function toAudioAssetOut(row: AudioAssetRow): AudioAssetOut {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    filename: row.filename,
    createdAt: row.createdAt
  };
}

/** One entry of §5.9's blocking-reference list, as a delete refusal carries it. */
export type Reference = { kind: string; id: string; label: string };

/**
 * The greetings, MoH classes, mailbox greetings, announcement targets and menus still using
 * audio asset `audioId` (§5.9): a soft delete is refused while any of these exist.
 */
export async function findAudioAssetReferences(
  db: Db,
  audioId: string
): Promise<Reference[]> {
  const queries = audioReferenceQueries(db, audioId);
  const [ringGroups, users, menus, settingsRows, announcementTargetIds] =
    await Promise.all([
      queries.ringGroups.select('name').execute(),
      queries.users.select('name').execute(),
      queries.menus.select('name').execute(),
      queries.settings.execute(),
      queries.forwardTargets.execute()
    ]);
  const announcements = await findForwardTargetOwners(
    db,
    announcementTargetIds.map(row => row.id)
  );
  return [
    ...ringGroups.map(row => ({
      kind: 'ringGroup',
      id: row.id,
      label: row.name
    })),
    ...users.map(row => ({ kind: 'user', id: row.id, label: row.name })),
    ...menus.map(row => ({ kind: 'menu', id: row.id, label: row.name })),
    ...settingsRows.map(() => ({
      kind: 'settings',
      id: 'tenant',
      label: 'tenant hold music default'
    })),
    ...announcements
  ];
}

/**
 * Throws `OpError(404)` unless `audioId` names a live `audio_assets` row, and `OpError(422)` unless
 * that row is of `kind`, the kind its referencing column names in §11.2.
 */
export async function assertAudioOfKind(
  db: Db,
  audioId: string,
  kind: AudioKind
): Promise<void> {
  const row = await liveAudioAsset(db, audioId);
  if (row.kind !== kind) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `audio asset '${audioId}' is of kind '${row.kind}', not '${kind}'`
    );
  }
}
