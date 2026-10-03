import { rm } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import type { Selectable, Transaction } from 'kysely';
import pino from 'pino';

import {
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  mwiMailboxOf,
  type DB,
  type MwiMailbox
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { ringGroupMemberships } from '#lib/server/ringGroupMembership.js';

import { afterCommit } from '../afterCommit.js';
import { OpError, type Context } from '../types.js';

const logger = pino({ name: 'voicemails' });

/** A `voicemails` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type VoicemailRow = Selectable<DB['voicemails']>;

export type VoicemailOut = {
  id: string;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  caller: string;
  filename: string;
  durationS: number;
  read: boolean;
  createdAt: string;
};

export function toVoicemailOut(row: VoicemailRow): VoicemailOut {
  return {
    id: row.id,
    mailboxUserId: row.mailboxUserId,
    mailboxRingGroupId: row.mailboxRingGroupId,
    caller: row.caller,
    filename: row.filename,
    durationS: row.durationS,
    read: row.read !== 0,
    createdAt: row.createdAt
  };
}

/** The ring groups `userId` belongs to (§5.3, `ringGroupMemberships`). */
export async function ringGroupIdsForUser(
  db: Transaction<DB>,
  userId: string
): Promise<string[]> {
  const rows = await ringGroupMemberships(db, { userId });
  return rows.map(row => row.ringGroupId);
}

/**
 * The voicemail with `id` that `ctx.actor` may act on: its own mailbox, the mailbox of a ring group
 * it belongs to, or any mailbox for an admin/owner (§5.3). Throws `OpError(404)` for an unknown id
 * (`voicemails` carries no soft delete, §11.2) and `OpError(403)` for another's mailbox.
 */
export async function loadVisibleVoicemail(
  ctx: Context,
  id: string
): Promise<VoicemailRow> {
  const row = await ctx.db
    .selectFrom('voicemails')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, `voicemail '${id}' not found`);
  }
  if (ctx.actor.role !== 'user') {
    return row;
  }
  const ringGroupIds = await ringGroupIdsForUser(ctx.db, ctx.actor.id);
  const own =
    row.mailboxUserId === ctx.actor.id ||
    (row.mailboxRingGroupId !== null &&
      ringGroupIds.includes(row.mailboxRingGroupId));
  if (!own) {
    throw new OpError(
      HTTP_FORBIDDEN,
      'voicemails: may act only on your own mailbox'
    );
  }
  return row;
}

/** The `MwiMailbox` a voicemail row's owning mailbox is addressed as (§3.1, §9.3, `mwiMailboxOf`). */
export function mailboxKey(
  row: Pick<VoicemailRow, 'mailboxUserId' | 'mailboxRingGroupId'>
): MwiMailbox {
  if (row.mailboxUserId !== null) {
    return mwiMailboxOf({ userId: row.mailboxUserId });
  }
  if (row.mailboxRingGroupId !== null) {
    return mwiMailboxOf({ ringGroupId: row.mailboxRingGroupId });
  }
  throw new Error(
    'voicemails: row has neither a user nor a ring group mailbox'
  );
}

export const VOICEMAIL_SUBDIR = 'voicemail';

/** Removes a voicemail's audio file from the media volume; missing files are not an error. */
export async function deleteVoicemailFile(
  filename: string,
  mediaDir: string = env.MEDIA_DIR
): Promise<void> {
  await rm(path.join(mediaDir, VOICEMAIL_SUBDIR, filename), { force: true });
}

/**
 * Has `core` refresh `mailbox`'s voicemail count (§3.1, §9.3 MWI) once `ctx`'s write has
 * committed, never after a rollback. Not awaited, so the caller's result never waits on `core`; a
 * failure leaves the lamp as it was until the mailbox next changes, and is logged.
 */
export function notifyMwi(ctx: Context, mailbox: MwiMailbox): void {
  afterCommit(ctx, () => {
    getCoreClient()
      .mwi(mailbox)
      .catch((error: unknown) => {
        logger.warn({ err: error, mailbox }, 'MWI update failed');
      });
    return Promise.resolve(null);
  });
}
