/**
 * Voicemail deposit (§10.1 step 6/7 mailbox targets; §10.2 "Voicemail"; §11.5, §11.6): answers
 * the caller, plays the mailbox's own greeting or the language default, records to the media
 * volume, then writes the `voicemails` row, updates MWI, emits `voicemail.new`, and posts the
 * mail request that `api` sends on `core`'s behalf (§3.1 "Mail").
 */
import { newId, type Db } from '@zamfono/shared';

import type { ApiClient } from '../apiClient.js';
import type { Snapshot } from '../internal/server.js';
import { assetMedia, defaultPrompt } from '../prompts.js';
import { release, type Call, type Owner } from './call.js';
import { finishAbandoned } from './missedCall.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { recordCaller } from './voicemailRecording.js';
import { persistVoicemail } from './voicemailStore.js';

export { mwiCounts } from './voicemailStore.js';

const RELEASE_CODE_UNAVAILABLE = 480;
const RELEASE_CODE_SERVER_ERROR = 500;

/** Just the surface `deposit` needs from `ApiClient`, so a test can stub it without its private
 * `baseUrl` field. */
export type MailSender = Pick<ApiClient, 'mail'>;

/**
 * Why a call reached a mailbox, for the `voicemail` trace line (§7 "fallback taken"): the user's
 * DND or `offline` at Entry, a ring's `busy` or `noAnswer` outcome, a ring group's `unanswered` or
 * `unavailable` fallback, a mailbox as the forward target itself (`target`), an anonymous caller
 * rejected (`rejectAnonymous`), the hop limit (`hopLimit`), the `*97` feature code (`feature`) or
 * a transfer to voicemail (`transfer`).
 */
export type DepositReason =
  | 'dnd'
  | 'offline'
  | 'busy'
  | 'noAnswer'
  | 'unanswered'
  | 'unavailable'
  | 'target'
  | 'rejectAnonymous'
  | 'hopLimit'
  | 'feature'
  | 'transfer';

/** The mailbox owner's display name and greeting, from the config snapshot (FK-guaranteed present). */
function findOwner(
  snapshot: Snapshot,
  mailbox: Owner
): { name: string; mailboxAudioId: string | null } {
  const row =
    'userId' in mailbox
      ? snapshot.users.find(candidate => candidate.id === mailbox.userId)
      : snapshot.ringGroups.find(
          candidate => candidate.id === mailbox.ringGroupId
        );
  if (row === undefined) {
    throw new Error(
      'voicemail: mailbox owner missing from the config snapshot'
    );
  }
  return row;
}

/** The phone-book caller name for `from` (§10.2 "Phone book"), empty for an anonymous caller or
 * one no `contact_phones` row matches. */
function mailDeps(
  pipeline: Pipeline
): { db: Db; apiClient: MailSender } | null {
  const { db, apiClient } = pipeline.deps;
  return db === undefined || apiClient === undefined ? null : { db, apiClient };
}

/** `deposit`'s own steps, from the answer to the row the outcome leaves. */
async function recordMessage(
  pipeline: Pipeline,
  call: Call,
  mailbox: Owner,
  reason: DepositReason | null
): Promise<void> {
  const deps = mailDeps(pipeline);
  if (deps === null) {
    call.log.event({ event: 'voicemailFailed', reason: 'missingDeps' });
    await release(pipeline, call, RELEASE_CODE_SERVER_ERROR, 'failed');
    return;
  }
  const { db, apiClient } = deps;
  const snapshot = await pipeline.deps.cache.get();
  const owner = findOwner(snapshot, mailbox);
  const greeting =
    owner.mailboxAudioId === null
      ? defaultPrompt('vmIntro')
      : assetMedia(snapshot.audioAssets, owner.mailboxAudioId);
  const id = newId();
  // The recording spool directory resolving this into `/media/voicemail/<id>.wav` (§11.6) is the
  // asterisk image's own configuration; this name is core's side of that path.
  const recordingName = `voicemail/${id}`;

  call.log.event({ event: 'voicemail', mailbox, reason });
  await pipeline.deps.ari.channels
    .answer(call.callerChannelId)
    .catch(() => undefined);
  const greetingEnd = await playAndWait(
    pipeline.deps.ari,
    call.callerChannelId,
    greeting,
    `${call.callerChannelId}:vmGreeting`
  );
  if (greetingEnd === 'hangup') {
    call.log.event({ event: 'voicemailFailed', mailbox, reason: 'hangup' });
    await finishAbandoned(pipeline, call);
    return;
  }

  const outcome = await recordCaller(
    pipeline.deps.ari,
    call.callerChannelId,
    recordingName,
    snapshot.settings.voicemailMaxS
  );
  if (outcome.kind !== 'finished') {
    // A recording that ended with the channel, the caller having hung up, is a caller who left
    // no message, not a fault.
    const failure =
      outcome.kind === 'destroyed' && call.ending?.by === 'caller'
        ? 'callerHungUp'
        : outcome.kind;
    call.log.event({ event: 'voicemailFailed', mailbox, reason: failure });
    // A caller already gone left no message rather than hitting a recording fault.
    const callerLeft =
      outcome.kind === 'destroyed' || call.callerEnded === true;
    await (callerLeft
      ? finishAbandoned(pipeline, call)
      : release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed'));
    return;
  }
  await playAndWait(
    pipeline.deps.ari,
    call.callerChannelId,
    defaultPrompt('vmGoodbye'),
    `${call.callerChannelId}:vmGoodbye`
  );

  await persistVoicemail({
    pipeline,
    db,
    apiClient,
    call,
    mailbox,
    owner,
    id,
    durationS: outcome.durationS
  });
}

/**
 * Deposits the caller in `mailbox` (§10.2 "Voicemail"): answer, greeting, record capped at
 * `settings.voicemail_max_s`, then the `voicemails` row, MWI, `voicemail.new` and the mail
 * request, before hanging up. A recording that failed releases the caller without any of that
 * (§10.2 "Voicemail"); a caller who hung up before leaving a message was missed.
 *
 * The deposit owns the call's row from here on (`call.depositing`): the caller hanging up is the
 * ordinary end of a message, and only the recording's outcome, which follows the channel, says
 * whether the call ends as `voicemail` with the voicemail mail alone (§10.2 "Mail") or as
 * `missed`. A flow that stops short of closing the row after the caller left still closes it.
 * `reason` is why the call reached the mailbox, for its trace line (§7 "fallback taken").
 */
export async function deposit(
  pipeline: Pipeline,
  call: Call,
  mailbox: Owner,
  reason: DepositReason | null = null
): Promise<void> {
  call.depositing = true;
  try {
    await recordMessage(pipeline, call, mailbox, reason);
  } finally {
    // eslint-disable-next-line require-atomic-updates -- the deposit is this flag's only writer; nothing else clears it meanwhile
    call.depositing = false;
    if (call.callerEnded === true) {
      await finishAbandoned(pipeline, call);
    }
  }
}
