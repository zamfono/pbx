/**
 * The `codecs` trace line (§7 `events`): the codec each side of an answered call's bridge was
 * negotiated to, so a codec mismatch, or a bridge that transcodes, shows in the routing trace
 * without a SIP capture.
 */
import { logFailure } from '../ari/failures.js';
import type { Call, Leg } from './call.js';
import type { Pipeline } from './pipeline.js';

// Asterisk renders a format list as `(ulaw|alaw)`, and an empty one as `(nothing)`.
const FORMAT_LIST = /^\((?<names>.*)\)$/u;

/** `CHANNEL(audionativeformat)` of `channelId`, the codec its media was negotiated to; `null`
 * when the channel has none (or is gone). */
async function nativeCodec(
  pipeline: Pipeline,
  channelId: string
): Promise<string | null> {
  const value = await pipeline.deps.ari.channels.getVariable(
    channelId,
    'CHANNEL(audionativeformat)'
  );
  const names = value?.match(FORMAT_LIST)?.groups?.names ?? value ?? '';
  return names === '' || names === 'nothing' ? null : names;
}

/**
 * Reads both sides' codecs once the bridge is up and appends the line, without holding the answer
 * back; `callerChannelId` is null where the answering leg joined a bridge the caller's channel is
 * not in. Nothing is written when neither channel answers.
 */
export function traceCodecs(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  callerChannelId: string | null
): void {
  Promise.all([
    callerChannelId === null
      ? Promise.resolve(null)
      : nativeCodec(pipeline, callerChannelId),
    nativeCodec(pipeline, leg.channelId)
  ])
    .then(([caller, callee]) => {
      if (caller === null && callee === null) {
        return;
      }
      call.log.event({
        event: 'codecs',
        channelId: leg.channelId,
        ...(caller === null ? {} : { caller }),
        ...(callee === null ? {} : { callee })
      });
    })
    .catch(
      logFailure(pipeline.deps.logger, 'codec trace', { callId: call.id })
    );
}
