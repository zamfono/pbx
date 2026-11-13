/** Key `0` of the mailbox menu (§10.2 "Mailbox access"): a greeting recorded by phone, which
 * makes `core` insert the `audio_assets` row and set the mailbox's `mailbox_audio_id` (§3.1
 * "Known cross-writes"). The menu itself is `mailbox.ts`'s. */
import {
  deletePromptFiles,
  MS_PER_SECOND,
  newId,
  PROMPTS_SUBDIR,
  retireGreeting,
  type Db
} from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import { defaultPrompt } from '../prompts.js';
import { waitForRecording } from './ariWaits.js';
import { callerChannel, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { type Owner } from './release.js';

const RECORDING_FALLBACK_BUFFER_S = 5;
// ponytail: fixed cap; no per-tenant setting exists for a recorded greeting's own length.
const MAILBOX_GREETING_MAX_S = 30;
const MAILBOX_GREETING_SILENCE_S = 3;

/** Inserts the recorded greeting's `audio_assets` row, points the mailbox at it and deletes the
 * greeting it replaces (§5.9), in one transaction; returns the id of the one deleted, or `null`. */
async function storeGreeting(
  db: Db,
  owner: Owner,
  greeting: { id: string; uploadedBy: string; now: string }
): Promise<string | null> {
  const { id, uploadedBy, now } = greeting;
  return db.transaction().execute(async trx => {
    await trx
      .insertInto('audioAssets')
      .values({
        id,
        kind: 'vmGreeting',
        label: 'Mailbox greeting',
        filename: `${id}.wav`,
        uploadedBy,
        createdAt: now
      })
      .execute();
    let previous: { mailboxAudioId: string | null } | undefined;
    if ('userId' in owner) {
      previous = await trx
        .selectFrom('users')
        .select('mailboxAudioId')
        .where('id', '=', owner.userId)
        .executeTakeFirst();
      await trx
        .updateTable('users')
        .set({ mailboxAudioId: id })
        .where('id', '=', owner.userId)
        .execute();
    } else {
      previous = await trx
        .selectFrom('ringGroups')
        .select('mailboxAudioId')
        .where('id', '=', owner.ringGroupId)
        .executeTakeFirst();
      await trx
        .updateTable('ringGroups')
        .set({ mailboxAudioId: id })
        .where('id', '=', owner.ringGroupId)
        .execute();
    }
    return retireGreeting(trx, previous?.mailboxAudioId ?? null);
  });
}

/** Digit `0`: plays `instructions`, then records a new greeting after a tone into `audio_assets`
 * kind `vmGreeting` and sets it as `mailbox_audio_id`, replacing the previous one, whose row is
 * deleted in the same transaction and its files once it committed (§10.2 "Mailbox access",
 * §5.9). While the media volume is at `MEDIA_STORAGE_MAX` (§11.6) nothing is recorded and the
 * greeting stays: the caller hears the mailbox-full prompt, as a refused voicemail's caller does.
 * Whether a greeting was stored, or `mediaFull`. */
export async function recordGreeting(
  pipeline: Pipeline,
  call: Call,
  owner: Owner,
  instructions: string
): Promise<'saved' | 'failed' | 'mediaFull'> {
  const db = pipeline.deps.db;
  if (call.callerUserId === null) {
    return 'failed';
  }
  const channelId = callerChannel(call);
  const ari = pipeline.deps.ari;
  const id = newId();
  const played = await playAndWait(
    ari,
    channelId,
    instructions,
    `${channelId}:greetingInstructions:${id}`
  );
  if (played === 'hangup') {
    return 'failed';
  }
  // Checked as the recording would start; one already recording when the limit is reached
  // finishes, as a message does.
  if (await pipeline.deps.mediaFull()) {
    pipeline.deps.logger.warn(
      { callId: call.id, mailbox: owner },
      'mailbox greeting not recorded: the media volume is at MEDIA_STORAGE_MAX'
    );
    await playAndWait(
      ari,
      channelId,
      defaultPrompt('vmMailboxFull'),
      `${channelId}:greetingMediaFull:${id}`
    );
    return 'mediaFull';
  }
  // The recording's name in Asterisk's spool (§11.6), where `assetMedia` finds an asset.
  const name = `${PROMPTS_SUBDIR}/${id}`;
  const finished = waitForRecording(
    ari,
    name,
    (MAILBOX_GREETING_MAX_S + RECORDING_FALLBACK_BUFFER_S) * MS_PER_SECOND
  );
  await ari.channels
    .record(channelId, {
      name,
      format: 'wav',
      maxDurationSeconds: MAILBOX_GREETING_MAX_S,
      maxSilenceSeconds: MAILBOX_GREETING_SILENCE_S,
      terminateOn: '#',
      beep: true
    })
    .catch(ignoreGone);
  const durationS = await finished;
  if (durationS === null) {
    return 'failed';
  }
  const retired = await storeGreeting(db, owner, {
    id,
    uploadedBy: call.callerUserId,
    now: pipeline.deps.now()
  });
  // Core's own cross-write (§3.1) reaches no `/internal/configChanged`; `deposit` resolves the
  // greeting from the config snapshot, so it must reload after these writes.
  pipeline.deps.cache.invalidate();
  if (retired !== null) {
    // Once no reloaded snapshot names it. A file this misses has no row left: `api`'s orphan
    // sweep takes it (§11.6).
    await deletePromptFiles(pipeline.deps.mediaDir, retired).catch(
      (error: unknown) => {
        pipeline.deps.logger.warn(
          { err: error, audioId: retired },
          'mailbox: the replaced greeting files were not deleted'
        );
      }
    );
  }
  return 'saved';
}
