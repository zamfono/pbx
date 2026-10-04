import { rm } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';
import type { Selectable, Transaction } from 'kysely';
import pino from 'pino';
import { z } from 'zod';

import {
  HTTP_NOT_FOUND,
  mwiMailboxOf,
  VOICEMAIL_SUBDIR,
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

/** A voicemail as `voicemails.list` lists it. */
export const voicemailOut = z.object({
  id: z.string(),
  mailboxUserId: z.string().nullable(),
  mailboxRingGroupId: z.string().nullable(),
  caller: z.string(),
  filename: z.string(),
  durationS: z.number(),
  read: z.boolean(),
  createdAt: z.string()
});
export type VoicemailOut = z.infer<typeof voicemailOut>;

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

/** The voicemail with `id`, or `OpError(404)`: `voicemails` carries no soft delete (§11.2). */
export async function loadVoicemail(
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
  return row;
}

/**
 * The `scope` of an operation on voicemail `id`: one in the caller's own mailbox or the mailbox
 * of a ring group they belong to (§5.3).
 */
export async function ownVoicemail(
  ctx: Context,
  input: { id: string }
): Promise<boolean> {
  const row = await loadVoicemail(ctx, input.id);
  if (row.mailboxUserId === ctx.actor.id) {
    return true;
  }
  const ringGroupIds = await ringGroupIdsForUser(ctx.db, ctx.actor.id);
  return (
    row.mailboxRingGroupId !== null &&
    ringGroupIds.includes(row.mailboxRingGroupId)
  );
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
