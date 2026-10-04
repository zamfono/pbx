/** Key `0` of the mailbox menu (§10.2 "Mailbox access"): a greeting recorded by phone, which
 * makes `core` insert the `audio_assets` row and set the mailbox's `mailbox_audio_id` (§3.1
 * "Known cross-writes"). The menu itself is `mailbox.ts`'s. */
import { MS_PER_SECOND, newId, retireGreeting, type Db } from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import { waitForRecording } from './ariWaits.js';
import { callerChannel, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { type Owner } from './release.js';

// media/prompts/ (§11.6): a recorded greeting's own spool path, matching `assetMedia`'s convention.
const PROMPTS_DIR_NAME = 'prompts';
const RECORDING_FALLBACK_BUFFER_S = 5;
// ponytail: fixed cap; no per-tenant setting exists for a recorded greeting's own length.
const MAILBOX_GREETING_MAX_S = 30;
const MAILBOX_GREETING_SILENCE_S = 3;

/** Inserts the recorded greeting's `audio_assets` row, points the mailbox at it and soft-deletes
 * the greeting it replaces, in one transaction. */
async function storeGreeting(
  db: Db,
  owner: Owner,
  greeting: { id: string; uploadedBy: string; now: string }
): Promise<void> {
  const { id, uploadedBy, now } = greeting;
  await db.transaction().execute(async trx => {
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
    await retireGreeting(trx, previous?.mailboxAudioId ?? null, now);
  });
}

/** Digit `0`: plays `instructions`, then records a new greeting after a tone into `audio_assets`
 * kind `vmGreeting` and sets it as `mailbox_audio_id`, replacing the previous one, which is
 * soft-deleted in the same transaction (§10.2 "Mailbox access"). Whether a greeting was stored. */
export async function recordGreeting(
  pipeline: Pipeline,
  call: Call,
  owner: Owner,
  instructions: string
): Promise<boolean> {
  const db = pipeline.deps.db;
  if (call.callerUserId === null) {
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
    .catch(ignoreGone);
  const durationS = await finished;
  if (durationS === null) {
    return false;
  }
  await storeGreeting(db, owner, {
    id,
    uploadedBy: call.callerUserId,
    now: pipeline.deps.now()
  });
  // Core's own cross-write (§3.1) reaches no `/internal/configChanged`; `deposit` resolves the
  // greeting from the config snapshot, so it must reload after these writes.
  pipeline.deps.cache.invalidate();
  return true;
}
