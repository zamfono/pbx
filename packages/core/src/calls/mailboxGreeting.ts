/** Key `0` of the mailbox menu (§10.2 "Mailbox access"): a greeting recorded by phone, which
 * makes `core` insert the `audio_assets` row and set the mailbox's `mailbox_audio_id` (§3.1
 * "Known cross-writes"). The menu itself is `mailbox.ts`'s. */
import { MS_PER_SECOND, newId } from '@zamfono/shared';

import { waitForRecording } from './ariWaits.js';
import { callerChannel, type Call, type Owner } from './call.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

// media/prompts/ (§11.6): a recorded greeting's own spool path, matching `assetMedia`'s convention.
const PROMPTS_DIR_NAME = 'prompts';
const RECORDING_FALLBACK_BUFFER_S = 5;
// ponytail: fixed cap; no per-tenant setting exists for a recorded greeting's own length.
const MAILBOX_GREETING_MAX_S = 30;
const MAILBOX_GREETING_SILENCE_S = 3;

/** Digit `0`: plays `instructions`, then records a new greeting after a tone into `audio_assets`
 * kind `vmGreeting` and sets it as `mailbox_audio_id`, replacing the previous one (§10.2
 * "Mailbox access"). Whether a greeting was stored. */
export async function recordGreeting(
  pipeline: Pipeline,
  call: Call,
  owner: Owner,
  instructions: string
): Promise<boolean> {
  const db = pipeline.deps.db;
  if (db === undefined || call.callerUserId === null) {
    return false;
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
    return false;
  }
  const name = `${PROMPTS_DIR_NAME}/${id}`;
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
    .catch(() => undefined);
  const durationS = await finished;
  if (durationS === null) {
    return false;
  }
  await db
    .insertInto('audioAssets')
    .values({
      id,
      kind: 'vmGreeting',
      label: 'Mailbox greeting',
      filename: `${id}.wav`,
      uploadedBy: call.callerUserId,
      createdAt: pipeline.deps.now()
    })
    .execute();
  if ('userId' in owner) {
    await db
      .updateTable('users')
      .set({ mailboxAudioId: id })
      .where('id', '=', owner.userId)
      .execute();
  } else {
    await db
      .updateTable('ringGroups')
      .set({ mailboxAudioId: id })
      .where('id', '=', owner.ringGroupId)
      .execute();
  }
  // Core's own cross-write (§3.1) reaches no `/internal/configChanged`; `deposit` resolves the
  // greeting from the config snapshot, so it must reload after these writes.
  pipeline.deps.cache.invalidate();
  return true;
}
