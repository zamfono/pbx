/**
 * A forward target's announcement and the `hangup` kind (§10.1 step 7; §11.2 `forward_targets`):
 * a target of any kind may play an announcement to the caller before the call goes where it sends
 * it, and a `hangup` target ends the call there.
 */
import { newId } from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import { assetMedia } from '../prompts.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { callerChannel, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { endCall, release } from './release.js';

/**
 * Plays a target's announcement to the caller, who is answered first, since without early media
 * they hear nothing before that, and returns once it has played to the end. Whether the call goes
 * on: not when the caller hung up meanwhile, which already closed the call out (`legsEnded.ts`).
 * A call with no caller channel has nobody to play to.
 */
export async function announce(
  pipeline: Pipeline,
  call: Call,
  audioId: string
): Promise<boolean> {
  if (call.callerChannelId === null) {
    return true;
  }
  const snapshot = await pipeline.deps.cache.get();
  const media = assetMedia(snapshot.audioAssets, audioId);
  call.log.event({ event: 'announce', audioId });
  const channelId = callerChannel(call);
  await pipeline.deps.ari.channels.answer(channelId).catch(ignoreGone);
  // Its own id each time, since a call may hear the same asset on two of its targets.
  const end = await playAndWait(
    pipeline.deps.ari,
    channelId,
    media,
    `${channelId}:announce:${newId()}`
  );
  return end !== 'hangup' && call.status === null;
}

/**
 * A `hangup` target: a caller who heard its announcement was answered by it, and the call ends
 * `answered`; without one the call is released unanswered with 480, `missed`, as an absent rule
 * without a mailbox ends it (§10.1 step 4).
 */
export async function hangUp(
  pipeline: Pipeline,
  call: Call,
  announced: boolean
): Promise<void> {
  if (!announced) {
    await release(pipeline, call, SIP_TEMPORARILY_UNAVAILABLE, 'missed');
    return;
  }
  call.answeredAt = pipeline.deps.now();
  await endCall(pipeline, call, 'answered');
}
