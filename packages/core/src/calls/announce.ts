/**
 * The Target-menu "announcement" terminal action (§10.1 step 6/7; §11.2 `forward_targets`
 * comment "announcement_audio_id: play the announcement, then hang up"). The caller is answered
 * first, since without early media the caller hears nothing before that, and hung up only once
 * the announcement has actually played to the end.
 */
import { assetMedia } from '../prompts.js';
import { callerChannel, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

export async function announce(
  pipeline: Pipeline,
  call: Call,
  audioId: string
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const media = assetMedia(snapshot.audioAssets, audioId);
  call.log.event({ event: 'announce', audioId });
  const channelId = callerChannel(call);
  await pipeline.deps.ari.channels.answer(channelId).catch(() => undefined);
  await playAndWait(
    pipeline.deps.ari,
    channelId,
    media,
    `${channelId}:announce`
  );
  // eslint-disable-next-line require-atomic-updates -- this call's only writer is this function
  call.answeredAt = pipeline.deps.now();
  // eslint-disable-next-line require-atomic-updates -- this call's only writer is this function
  call.status = 'answered';
  // §7: the channel whose `call_qos` row this call has is noted before it goes.
  pipeline.deps.cdr.noteQosLegs?.(call);
  await pipeline.deps.ari.channels.hangup(channelId).catch(() => undefined);
  await pipeline.finishCall(call);
}
