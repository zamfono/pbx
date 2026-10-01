/**
 * The mailbox menu's reads and writes (§10.2 "Mailbox access"): the messages in the order the
 * menu walks them, marking a new message read and deleting one, each followed by the MWI counts
 * it moved (§9.3 "MWI"). `mailboxMessages.ts` walks them.
 */
import { unlink } from 'node:fs/promises';

import type { Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { Owner } from './call.js';
import type { Folder } from './mailboxPrompts.js';
import { refreshMwi } from './voicemailStore.js';

export const VOICEMAIL_DIR = '/media/voicemail';

export type MailboxMessage = { id: string; filename: string; folder: Folder };

type StoreDeps = { ari: AriClient; db: Db };

/** The mailbox's messages in walking order: new before old, each folder oldest first. */
export async function loadMessages(
  db: Db,
  owner: Owner
): Promise<MailboxMessage[]> {
  const query =
    'userId' in owner
      ? db.selectFrom('voicemails').where('mailboxUserId', '=', owner.userId)
      : db
          .selectFrom('voicemails')
          .where('mailboxRingGroupId', '=', owner.ringGroupId);
  const rows = await query
    .select(['id', 'filename', 'read'])
    .orderBy('read', 'asc')
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(row => ({
    id: row.id,
    filename: row.filename,
    folder: row.read === 1 ? 'old' : 'new'
  }));
}

/** Marks a new message read the moment it first starts playing, and pushes the new counts
 * (§9.3); it stays in the new folder for the rest of the session, as the caller met it. */
export async function markRead(
  deps: StoreDeps,
  owner: Owner,
  message: MailboxMessage
): Promise<void> {
  if (message.folder === 'old') {
    return;
  }
  const result = await deps.db
    .updateTable('voicemails')
    .set({ read: 1 })
    .where('id', '=', message.id)
    .where('read', '=', 0)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) > 0) {
    await refreshMwi(deps, owner);
  }
}

/** Deletes a message, its row and its file, and pushes the new counts (§9.3). */
export async function deleteMessage(
  deps: StoreDeps,
  owner: Owner,
  message: MailboxMessage
): Promise<void> {
  await deps.db.deleteFrom('voicemails').where('id', '=', message.id).execute();
  await unlink(`${VOICEMAIL_DIR}/${message.filename}`).catch(() => undefined);
  await refreshMwi(deps, owner);
}
