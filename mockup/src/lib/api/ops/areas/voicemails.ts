/**
 * Voicemail (`ops/voicemails/`, §5.3): a `user` reaches their own mailbox and those of the ring
 * groups they belong to, an admin every mailbox. Read flags are outside the audit log; a delete is
 * permanent (§5.8).
 */
import { formatDateTime, formatPhone } from '#lib/i18n/index.svelte.js';

import { notFound } from '../../errors';
import { ringGroupsOf } from '../../events.svelte';
import type { Voicemail } from '../../types';
import { defineOp, type Ctx } from '../core';
import { paginate, type Page, type PageInput } from './calls';

/** A voicemail as `voicemails.list` lists it, without the mock's audio clip. */
export type VoicemailOut = Omit<Voicemail, 'clip' | 'callId'>;

/** What `voicemails.audio` hands out: the clip the player plays (the API's WAV or link, §10.5). */
export type AudioOut = {
  clip: string | null;
  filename: string;
  durationS: number;
  channels: 1 | 2;
};

export function toVoicemailOut(row: Voicemail): VoicemailOut {
  const { clip: _clip, callId: _callId, ...rest } = row;
  return rest;
}

function loadVoicemail(ctx: Ctx, id: string): Voicemail {
  const row = ctx.db.voicemails.find(candidate => candidate.id === id);
  if (row === undefined) {
    throw notFound('voicemail', id);
  }
  return row;
}

/** Whether voicemail `id` lies in the caller's own mailbox or one of their ring groups'. */
function ownVoicemail(ctx: Ctx, input: { id: string }): boolean {
  const row = loadVoicemail(ctx, input.id);
  if (row.mailboxUserId === ctx.actor.id) {
    return true;
  }
  return (
    row.mailboxRingGroupId !== null &&
    ringGroupsOf(ctx.db, ctx.actor.id).includes(row.mailboxRingGroupId)
  );
}

defineOp<PageInput, Page<VoicemailOut>>({
  name: 'voicemails.list',
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: (ctx, input) => {
    const groups =
      ctx.actor.role === 'user' ? ringGroupsOf(ctx.db, ctx.actor.id) : [];
    const rows = ctx.db.voicemails
      .filter(
        row =>
          ctx.actor.role !== 'user' ||
          row.mailboxUserId === ctx.actor.id ||
          (row.mailboxRingGroupId !== null &&
            groups.includes(row.mailboxRingGroupId))
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toVoicemailOut);
    return paginate(ctx.operation, rows, input);
  }
});

defineOp<{ id: string; format?: 'opus' | 'mp3' }, AudioOut>({
  name: 'voicemails.audio',
  minRole: 'user',
  scope: ownVoicemail,
  readOnly: true,
  run: (ctx, input) => {
    const row = loadVoicemail(ctx, input.id);
    const extension = input.format ?? 'wav';
    return {
      clip: row.clip,
      filename: row.filename.replace(/\.wav$/u, `.${extension}`),
      durationS: row.durationS,
      channels: 1
    };
  }
});

defineOp<{ id: string; read: boolean }, { id: string; read: boolean }>({
  name: 'voicemails.markRead',
  minRole: 'user',
  scope: ownVoicemail,
  run: (ctx, input) => {
    const row = loadVoicemail(ctx, input.id);
    row.read = input.read;
    return { id: row.id, read: row.read };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'voicemails.delete',
  minRole: 'user',
  scope: ownVoicemail,
  confirm: (ctx, input) => {
    const row = loadVoicemail(ctx, input.id);
    return {
      key: 'voicemails.delete',
      params: {
        caller: row.caller === 'anonymous' ? '—' : formatPhone(row.caller),
        at: formatDateTime(row.createdAt)
      },
      destructive: true,
      irreversible: true
    };
  },
  run: (ctx, input) => {
    const row = loadVoicemail(ctx, input.id);
    const before = { ...row };
    // A hard delete: `voicemails` carries no soft delete, and the audio file goes with it.
    ctx.db.voicemails = ctx.db.voicemails.filter(
      candidate => candidate.id !== row.id
    );
    ctx.audit({
      entityKind: 'voicemail',
      entityId: row.id,
      before,
      after: null,
      undoable: false
    });
    return { id: row.id };
  }
});
