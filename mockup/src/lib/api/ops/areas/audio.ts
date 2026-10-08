/**
 * The audio library (`ops/audio/`, admin): greetings, hold music, mailbox greetings and
 * announcements. An upload is WAV or MP3 (at most 50 MB, refused by the HTTP layer before the
 * operation runs) and transcoded for playback; only the label changes afterwards. A delete is
 * refused while anything still plays the asset (§5.9). The bundled hold music is an ordinary
 * `moh` asset.
 */
import { conflict, invalid, notFound, type BlockingRef } from '../../errors';
import { newId } from '../../ids';
import {
  AUDIO_KINDS,
  type AudioAsset,
  type AudioKind,
  type Db
} from '../../types';
import { defineOp } from '../core';
import { softDeleteConfirm, targetOwners } from './ooo';

/** The MIME types an upload may declare (`uploadTypes.ts`). */
export const UPLOAD_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3'
];
/** The largest upload (`BODY_SIZE_LIMIT`, §10.2). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The file of `audio.create`; the mock keeps its name, type, size and measured length. */
export type AudioUpload = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationS: number;
};

function liveAsset(db: Db, id: string): AudioAsset {
  const asset = db.audio.find(row => row.id === id && row.deletedAt === null);
  if (asset === undefined) {
    throw notFound('audio', id);
  }
  return asset;
}

function requireLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid('label', 'groups.required', 'label is required');
  }
  return value.trim();
}

/**
 * What still plays audio `id` (`findAudioAssetReferences`): ring groups' greeting, music or
 * mailbox greeting, users' mailbox greetings, menus' greetings, the tenant's hold music and every
 * announcement target.
 */
export function audioReferences(db: Db, id: string): BlockingRef[] {
  return [
    ...db.ringGroups
      .filter(
        group =>
          group.deletedAt === null &&
          [
            group.greetingAudioId,
            group.mohAudioId,
            group.mailboxAudioId
          ].includes(id)
      )
      .map(group => ({ kind: 'ringGroup', id: group.id, label: group.name })),
    ...db.users
      .filter(user => user.deletedAt === null && user.mailboxAudioId === id)
      .map(user => ({ kind: 'user', id: user.id, label: user.name })),
    ...db.menus
      .filter(menu => menu.deletedAt === null && menu.audioId === id)
      .map(menu => ({ kind: 'menu', id: menu.id, label: menu.name })),
    ...(db.settings.holdMohAudioId === id
      ? [{ kind: 'settings', id: 'tenant', label: db.settings.companyName }]
      : []),
    ...targetOwners(
      db,
      target => target.kind === 'announcement' && target.audioId === id
    )
  ];
}

defineOp<Record<string, never>, { items: AudioAsset[] }>({
  name: 'audio.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.audio
      .filter(row => row.deletedAt === null)
      .toSorted((first, second) => first.label.localeCompare(second.label))
  })
});

defineOp<{ kind: AudioKind; label: string; upload: AudioUpload }, AudioAsset>({
  name: 'audio.create',
  minRole: 'admin',
  run: (ctx, input) => {
    if (!AUDIO_KINDS.includes(input.kind)) {
      throw invalid(
        'kind',
        'groups.audioKindUnknown',
        'kind must be greeting, moh, vmGreeting or announcement'
      );
    }
    const label = requireLabel(input.label);
    if (
      input.upload === undefined ||
      !UPLOAD_TYPES.includes(input.upload.mimeType.toLowerCase())
    ) {
      throw invalid(
        'upload',
        'groups.uploadType',
        'upload: only WAV and MP3 are accepted'
      );
    }
    const row: AudioAsset = {
      id: newId(),
      kind: input.kind,
      label,
      durationS: Math.max(1, Math.round(input.upload.durationS)),
      bundled: false,
      createdAt: ctx.now,
      deletedAt: null,
      clip: null
    };
    ctx.insert('audio', row);
    ctx.audit({
      entityKind: 'audio',
      entityId: row.id,
      before: null,
      after: row
    });
    return row;
  }
});

defineOp<{ id: string; label: string }, AudioAsset>({
  name: 'audio.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveAsset(ctx.db, input.id);
    const next = { ...before, label: requireLabel(input.label) };
    ctx.put('audio', next);
    ctx.audit({
      entityKind: 'audio',
      entityId: next.id,
      before: { ...before },
      after: next
    });
    return next;
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'audio.delete',
  minRole: 'admin',
  confirm: (ctx, input) =>
    softDeleteConfirm(ctx, 'audio.delete', {
      name: liveAsset(ctx.db, input.id).label
    }),
  run: (ctx, input) => {
    const asset = liveAsset(ctx.db, input.id);
    const refs = audioReferences(ctx.db, asset.id);
    if (refs.length > 0) {
      throw conflict('inUse', 'audio asset is still in use', refs);
    }
    const before = { ...asset };
    ctx.softDelete('audio', asset.id);
    ctx.audit({
      entityKind: 'audio',
      entityId: asset.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: asset.id };
  }
});
