/**
 * What a recorded voicemail leaves behind (§10.2 "Voicemail", §11.5): the `voicemails` row, the
 * mailbox's own MWI counts, the `voicemail.new` event and the mail request `api` sends on `core`'s
 * behalf (§3.1 "Mail"). Separate from the deposit flow itself, which is about the call. The MWI
 * push after any later mailbox change (§9.3 "MWI", `refreshMwi`) reads the same counts.
 */
import {
  mwiMailboxOf,
  parseMwiMailbox,
  type Db,
  type MailRequest,
  type MwiMailbox
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { Call, Owner } from './call.js';
import { contactName } from './contactName.js';
import type { Pipeline } from './pipeline.js';
import type { MailSender } from './voicemail.js';

// §11.6: voicemail recordings live here, the directory Asterisk's recording base resolves to.
const VOICEMAIL_DIR = '/media/voicemail';

/** The mailbox's current old (read) and new (unread) counts (§9.3 "MWI"); `refreshMwi` reuses it. */
export async function mwiCounts(
  db: Db,
  mailbox: Owner
): Promise<{ oldMessages: number; newMessages: number }> {
  const query =
    'userId' in mailbox
      ? db.selectFrom('voicemails').where('mailboxUserId', '=', mailbox.userId)
      : db
          .selectFrom('voicemails')
          .where('mailboxRingGroupId', '=', mailbox.ringGroupId);
  const rows = await query.select('read').execute();
  const newMessages = rows.filter(row => row.read === 0).length;
  return { oldMessages: rows.length - newMessages, newMessages };
}

/** Recomputes `mailbox`'s MWI counts and pushes them (§9.3 "MWI"): called after core's own DTMF
 * mailbox menu changes a read flag or deletes a message, and by the internal route `api` calls
 * after doing the same. */
export async function refreshMwi(
  deps: { ari: AriClient; db: Db },
  mailbox: MwiMailbox
): Promise<void> {
  const { oldMessages, newMessages } = await mwiCounts(
    deps.db,
    parseMwiMailbox(mailbox)
  );
  await deps.ari.mailboxes
    .put(mailbox, oldMessages, newMessages)
    .catch(() => undefined);
}

export type DepositContext = {
  pipeline: Pipeline;
  db: Db;
  apiClient: MailSender;
  call: Call;
  mailbox: Owner;
  owner: { name: string; mailboxAudioId: string | null };
  id: string;
  durationS: number;
};

/**
 * The recording's aftermath: the `voicemails` row, the MWI push, `voicemail.new`, the mail
 * request, then the hangup and `cdr.finish` that close the call out.
 */
export async function persistVoicemail(ctx: DepositContext): Promise<void> {
  const { pipeline, db, apiClient, call, mailbox, owner, id, durationS } = ctx;
  const filename = `${id}.wav`;
  const createdAt = pipeline.deps.now();
  await db
    .insertInto('voicemails')
    .values({
      id,
      caller: call.from,
      createdAt,
      durationS,
      filename,
      mailboxUserId: 'userId' in mailbox ? mailbox.userId : null,
      mailboxRingGroupId: 'ringGroupId' in mailbox ? mailbox.ringGroupId : null
    })
    .execute();

  const name = mwiMailboxOf(mailbox);
  const { oldMessages, newMessages } = await mwiCounts(db, mailbox);
  await pipeline.deps.ari.mailboxes
    .put(name, oldMessages, newMessages)
    .catch(() => undefined);
  pipeline.deps.bus.emit({
    type: 'voicemail.new',
    voicemailId: id,
    mailbox: name
  });

  const mailRequest: MailRequest = {
    kind: 'voicemail',
    callId: call.id,
    to: mailbox,
    values: {
      callerNumber: call.from,
      callerName: await contactName(db, call.from),
      mailboxName: owner.name,
      receivedAt: createdAt,
      durationS
    },
    attachmentPath: `${VOICEMAIL_DIR}/${filename}`
  };
  apiClient.mail(mailRequest).catch(() => undefined);

  call.status = 'voicemail';
  pipeline.deps.cdr.noteQosLegs?.(call);
  await pipeline.deps.ari.channels
    .hangup(call.callerChannelId)
    .catch(() => undefined);
  await pipeline.deps.cdr.finish(call);
}

/** `pipeline.deps.db`/`apiClient`, or `null` for a test Pipeline built without them. */
