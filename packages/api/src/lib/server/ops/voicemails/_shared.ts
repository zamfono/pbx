import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { sql, type Selectable, type Transaction } from 'kysely';
import pino from 'pino';

import { mwiMailboxOf, type DB, type MwiMailbox } from '@zamfono/shared';

import { transcodeForDownload } from '#lib/server/audio/transcode.js';
import { createCoreClient, type CoreClient } from '#lib/server/coreClient.js';
import { mediaDirFromEnv } from '#lib/server/mediaDir.js';

import { afterCommit } from '../afterCommit.js';
import { OpError, type Context, type Role } from '../types.js';

const logger = pino({ name: 'voicemails' });

const STATUS_NOT_FOUND = 404;
const STATUS_FORBIDDEN = 403;

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
    throw new OpError(STATUS_NOT_FOUND, `voicemail '${id}' not found`);
  }
  return row;
}

type RingGroupIdRow = { ringGroupId: string };

/**
 * The ring groups `userId` belongs to (§5.3), direct or through a nested `user_groups` tree: the
 * recursive CTE mirrors the schema's own `user_group_groups_no_cycle` trigger, since nesting can
 * be arbitrarily deep and cycles are already rejected on write (mirrors `propagation.ts`'s own
 * per-tenant version of this query).
 */
export async function ringGroupIdsForUser(
  db: Transaction<DB>,
  userId: string
): Promise<string[]> {
  const { rows } = await sql<RingGroupIdRow>`
    WITH RECURSIVE group_reach(root_group_id, group_id) AS (
      SELECT id, id FROM user_groups
      UNION
      SELECT gr.root_group_id, ugg.child_group_id
      FROM group_reach gr
      JOIN user_group_groups ugg ON ugg.parent_group_id = gr.group_id
    )
    SELECT DISTINCT rgm.group_id AS ringGroupId
    FROM ring_group_members rgm
    LEFT JOIN group_reach gr ON gr.root_group_id = rgm.user_group_id
    LEFT JOIN user_group_users ugu ON ugu.group_id = gr.group_id
    WHERE rgm.user_id = ${userId} OR ugu.user_id = ${userId}
  `.execute(db);
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
      STATUS_FORBIDDEN,
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

const VOICEMAIL_SUBDIR = 'voicemail';

/** Removes a voicemail's audio file from the media volume; missing files are not an error. */
export async function deleteVoicemailFile(
  filename: string,
  mediaDir: string = mediaDirFromEnv()
): Promise<void> {
  await rm(path.join(mediaDir, VOICEMAIL_SUBDIR, filename), { force: true });
}

export type AudioBytes = {
  bytes: Buffer;
  contentType: string;
  filename: string;
};

const CONTENT_TYPE_BY_DOWNLOAD_FORMAT: Record<'opus' | 'mp3', string> = {
  opus: 'audio/ogg',
  mp3: 'audio/mpeg'
};

/**
 * A voicemail's recorded audio (§10.3, §11.6): the stored WAV as-is with no `format`, or
 * transcoded to Opus/MP3 for download.
 */
export async function loadVoicemailAudio(
  filename: string,
  format: 'opus' | 'mp3' | undefined,
  mediaDir: string = mediaDirFromEnv()
): Promise<AudioBytes> {
  const filePath = path.join(mediaDir, VOICEMAIL_SUBDIR, filename);
  if (format === undefined) {
    return {
      bytes: await readFile(filePath),
      contentType: 'audio/wav',
      filename
    };
  }
  const bytes = await transcodeForDownload(filePath, format);
  const base = path.basename(filename, path.extname(filename));
  return {
    bytes,
    contentType: CONTENT_TYPE_BY_DOWNLOAD_FORMAT[format],
    filename: `${base}.${format}`
  };
}

let coreClient: CoreClient = createCoreClient();

/** Test-only: replaces the `CoreClient` a voicemail write notifies after commit. */
export function setCoreClientForTest(client: CoreClient): void {
  coreClient = client;
}

/**
 * Has `core` refresh `mailbox`'s voicemail count (§3.1, §9.3 MWI) once `ctx`'s write has
 * committed, never after a rollback. Not awaited, so the caller's result never waits on `core`; a
 * failure leaves the lamp as it was until the mailbox next changes, and is logged.
 */
export function notifyMwi(ctx: Context, mailbox: MwiMailbox): void {
  afterCommit(ctx, () => {
    coreClient.mwi(mailbox).catch((error: unknown) => {
      logger.warn({ err: error, mailbox }, 'MWI update failed');
    });
    return Promise.resolve(null);
  });
}
