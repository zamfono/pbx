import type { Selectable, Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import type { AudioKind } from '../../audio/types.js';
import { findForwardTargetOwners } from '../forwardTargetOwners.js';

/** An `audio_assets` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type AudioAssetRow = Selectable<DB['audioAssets']>;

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
    kind: row.kind as AudioKind,
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
