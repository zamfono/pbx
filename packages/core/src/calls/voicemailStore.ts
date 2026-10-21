/**
 * What a recorded voicemail leaves behind (§10.2 "Voicemail", §11.5): the `voicemails` row, the
 * mailbox's own MWI counts, the `voicemail.new` event and the mail request `api` sends on `core`'s
 * behalf (§3.1 "Mail"). Separate from the deposit flow itself, which is about the call. The MWI
 * push after any later mailbox change (§9.3 "MWI", `refreshMwi`) reads the same counts.
 */
import {
  mwiHintDevice,
  mwiMailboxOf,
  type Db,
  type MailRequest
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { logFailure } from '../ari/failures.js';
import { type Call } from './call.js';
import { callerNumber, contactName } from './contactName.js';
import type { Pipeline } from './pipeline.js';
import { endCall, type Owner } from './release.js';
import type { MailSender } from './voicemail.js';

/** The mailbox's current old (read) and new (unread) counts (§9.3 "MWI"); `refreshMwi` reuses it. */
async function mwiCounts(
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

/** Whether `mailbox` already holds `limit` messages (§11.5); a `null` limit is no limit. */
export async function mailboxFull(
  db: Db,
  mailbox: Owner,
  limit: number | null
): Promise<boolean> {
  if (limit === null) {
    return false;
  }
  const { oldMessages, newMessages } = await mwiCounts(db, mailbox);
  return oldMessages + newMessages >= limit;
}

/** The extension owning `mailbox`, whose hint is the mailbox's lamp (§9.3); `null` for a user
 * without one, who has no lamp. */
async function mailboxExtension(
  db: Db,
  mailbox: Owner
): Promise<string | null> {
  const row = await (
    'userId' in mailbox
      ? db.selectFrom('extensions').where('userId', '=', mailbox.userId)
      : db
          .selectFrom('extensions')
          .where('ringGroupId', '=', mailbox.ringGroupId)
  )
    .select('ext')
    .executeTakeFirst();
  return row?.ext ?? null;
}

/** Sets the lamp of the mailbox extension `ext` owns: `BUSY` while it holds new messages. */
async function pushLamp(
  ari: AriClient,
  ext: string,
  newMessages: number
): Promise<void> {
  await ari.deviceStates
    .put(mwiHintDevice(ext), newMessages > 0 ? 'BUSY' : 'NOT_INUSE')
    .catch(logFailure(ari.log, 'mailbox hint update', { ext }));
}

/** Pushes `mailbox`'s counts to Asterisk and its lamp, the mailbox hint's device state (§9.3
 * "MWI", "BLF and presence"). A failed PUT is logged; the next change writes both again. */
async function pushMwi(
  deps: { ari: AriClient; db: Db },
  mailbox: Owner
): Promise<void> {
  const [{ oldMessages, newMessages }, ext] = await Promise.all([
    mwiCounts(deps.db, mailbox),
    mailboxExtension(deps.db, mailbox)
  ]);
  await Promise.all([
    deps.ari.mailboxes
      .put(mwiMailboxOf(mailbox), oldMessages, newMessages)
      .catch(logFailure(deps.ari.log, 'MWI update')),
    ext === null ? undefined : pushLamp(deps.ari, ext, newMessages)
  ]);
}

/** Recomputes `mailbox`'s MWI counts and lamp and pushes them (§9.3 "MWI"): called after core's
 * own DTMF mailbox menu changes a read flag or deletes a message, and by the internal route `api`
 * calls after doing the same. */
export async function refreshMwi(
  deps: { ari: AriClient; db: Db },
  mailbox: Owner
): Promise<void> {
  await pushMwi(deps, mailbox);
}

/**
 * Writes the lamp of every user's and ring group's mailbox under its extension (§9.3), as the
 * presence and DND hints are: at boot, after an Asterisk restart and after every configuration
 * change, so a renumbered mailbox's lamp is right at once.
 */
export async function resyncMwiLamps(deps: {
  ari: AriClient;
  db: Db;
}): Promise<void> {
  const [owners, unread] = await Promise.all([
    deps.db
      .selectFrom('extensions')
      .select(['ext', 'userId', 'ringGroupId'])
      .where(eb =>
        eb.or([eb('userId', 'is not', null), eb('ringGroupId', 'is not', null)])
      )
      .execute(),
    deps.db
      .selectFrom('voicemails')
      .select(['mailboxUserId', 'mailboxRingGroupId'])
      .where('read', '=', 0)
      .execute()
  ]);
  const counts = new Map<string, number>();
  for (const row of unread) {
    const owner = row.mailboxUserId ?? row.mailboxRingGroupId ?? '';
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  await Promise.all(
    owners.map(row =>
      pushLamp(
        deps.ari,
        row.ext,
        counts.get(row.userId ?? row.ringGroupId ?? '') ?? 0
      )
    )
  );
}

type DepositContext = {
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
  await pushMwi({ ari: pipeline.deps.ari, db }, mailbox);
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
      callerNumber: callerNumber(call.from),
      callerName: await contactName(db, call.from),
      mailboxName: owner.name,
      receivedAt: createdAt,
      durationS
    },
    filename
  };
  apiClient
    .mail(mailRequest)
    .catch(
      logFailure(pipeline.deps.logger, 'voicemail mail', { callId: call.id })
    );

  await endCall(pipeline, call, 'voicemail');
}
