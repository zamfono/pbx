import { rm } from 'node:fs/promises';
import path from 'node:path';
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
import { mediaDirFromEnv } from '#lib/server/mediaDir.js';
import { ringGroupMemberships } from '#lib/server/ringGroupMembership.js';

import { afterCommit } from '../afterCommit.js';
import { OpError, type Context, type Role } from '../types.js';

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

/** Loads a voicemail by id, or throws `OpError(404)`; `voicemails` carries no soft delete (§11.2). */
export async function loadVoicemail(
  db: Transaction<DB>,
  id: string
): Promise<VoicemailRow> {
  const row = await db
    .selectFrom('voicemails')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(HTTP_NOT_FOUND, `voicemail '${id}' not found`);
  }
  return row;
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
 * Throws 403 unless `actorRole`/`actorId` may act on `row`: its own mailbox, the mailbox of a
 * ring group in `ringGroupIds`, or any mailbox for an admin/owner (§5.3).
 */
export function assertVoicemailScope(
  actorRole: Role,
  actorId: string,
  row: Pick<VoicemailRow, 'mailboxUserId' | 'mailboxRingGroupId'>,
  ringGroupIds: readonly string[]
): void {
  if (actorRole !== 'user') {
    return;
  }
  const own =
    row.mailboxUserId === actorId ||
    (row.mailboxRingGroupId !== null &&
      ringGroupIds.includes(row.mailboxRingGroupId));
  if (!own) {
    throw new OpError(
      HTTP_FORBIDDEN,
      'voicemails: may act only on your own mailbox'
    );
  }
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
  mediaDir: string = mediaDirFromEnv()
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
