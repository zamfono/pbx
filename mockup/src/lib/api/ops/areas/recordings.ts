/**
 * Recordings (`ops/recordings/`, §5.3, §10.2 "Recording semantics"): one per recorded user and
 * call, stereo — left the recorded person, right what they heard. Admins and owners only, a
 * user's own calls included; a delete is permanent (§5.8).
 */
import { formatDateTime } from '#lib/i18n/index.svelte.js';

import { notFound } from '../../errors';
import type { Recording } from '../../types';
import { defineOp, type Ctx } from '../core';
import { paginate, type Page, type PageInput } from './calls';
import type { AudioOut } from './voicemails';

export type RecordingOut = Omit<Recording, 'clip'>;

function loadRecording(ctx: Ctx, id: string): Recording {
  const row = ctx.db.recordings.find(candidate => candidate.id === id);
  if (row === undefined) {
    throw notFound('recording', id);
  }
  return row;
}

defineOp<PageInput, Page<RecordingOut>>({
  name: 'recordings.list',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) =>
    paginate(
      ctx.operation,
      [...ctx.db.recordings]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ clip: _clip, ...rest }) => rest),
      input
    )
});

defineOp<{ id: string; format?: 'opus' | 'mp3' }, AudioOut>({
  name: 'recordings.audio',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    const row = loadRecording(ctx, input.id);
    const extension = input.format ?? 'wav';
    return {
      clip: row.clip,
      filename: row.filename.replace(/\.wav$/u, `.${extension}`),
      durationS: row.durationS,
      channels: 2
    };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'recordings.delete',
  minRole: 'admin',
  confirm: (ctx, input) => ({
    key: 'recordings.delete',
    params: {
      at: formatDateTime(loadRecording(ctx, input.id).createdAt),
      name:
        ctx.db.users.find(
          user => user.id === loadRecording(ctx, input.id).userId
        )?.name ?? '—'
    },
    destructive: true,
    irreversible: true
  }),
  run: (ctx, input) => {
    const row = loadRecording(ctx, input.id);
    const before = { ...row };
    ctx.db.recordings = ctx.db.recordings.filter(
      candidate => candidate.id !== row.id
    );
    ctx.audit({
      entityKind: 'recording',
      entityId: row.id,
      before,
      after: null,
      undoable: false
    });
    return { id: row.id };
  }
});
