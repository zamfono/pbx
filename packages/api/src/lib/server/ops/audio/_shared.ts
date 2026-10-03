import type { Selectable, Transaction } from 'kysely';

import { type AudioKind, type DB } from '@zamfono/shared';

import { findForwardTargetOwners } from '../forwardTargetOwners.js';
import { liveRow } from '../rows.js';

/** An `audio_assets` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type AudioAssetRow = Selectable<DB['audioAssets']>;

/** Loads a live audio asset by id, or throws `OpError(404)`. */
export async function liveAudioAsset(
  db: Transaction<DB>,
  id: string
): Promise<AudioAssetRow> {
  return liveRow(db, 'audioAssets', id, `audio asset '${id}' not found`);
}

export type AudioAssetOut = {
  id: string;
  label: string;
  kind: AudioKind;
  filename: string;
  createdAt: string;
};

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
  db: Transaction<DB>,
  audioId: string
): Promise<Reference[]> {
  const [ringGroups, users, menus, settingsRows, announcementTargetIds] =
    await Promise.all([
      db
        .selectFrom('ringGroups')
        .select(['id', 'name'])
        .where('deletedAt', 'is', null)
        .where(eb =>
          eb.or([
            eb('greetingAudioId', '=', audioId),
            eb('mohAudioId', '=', audioId),
            eb('mailboxAudioId', '=', audioId)
          ])
        )
        .execute(),
      db
        .selectFrom('users')
        .select(['id', 'name'])
        .where('deletedAt', 'is', null)
        .where('mailboxAudioId', '=', audioId)
        .execute(),
      db
        .selectFrom('menus')
        .select(['id', 'name'])
        .where('deletedAt', 'is', null)
        .where('audioId', '=', audioId)
        .execute(),
      db
        .selectFrom('settings')
        .select('id')
        .where('holdMohAudioId', '=', audioId)
        .execute(),
      db
        .selectFrom('forwardTargets')
        .select('id')
        .where('announcementAudioId', '=', audioId)
        .execute()
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

/** Throws `OpError(404)` unless `audioId` names a live `audio_assets` row (a ring group's audio ids, `users.mailbox_audio_id`, §5.9). */
export async function assertAudioAvailable(
  db: Transaction<DB>,
  audioId: string
): Promise<void> {
  await liveAudioAsset(db, audioId);
}
