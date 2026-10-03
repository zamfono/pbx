/**
 * The voicemail deposit's recording (§10.2 "Voicemail"): `POST /channels/{id}/record` on the
 * caller and the wait for Asterisk's outcome of it, its own module beside `voicemail.ts`, which
 * owns the deposit's flow, so both stay under the repository's `max-lines` lint rule.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { isGone } from '../ari/failures.js';
import type { RecordParams } from '../ari/types.js';
import { channelLeft, recordingEnd, waitForEvent } from './ariWaits.js';

// §10.2 "Voicemail": the silence stop is a fixed constant, not a per-tenant setting, since it has
// to outlast a caller's pause for thought and stay short enough not to record dead air.
const VOICEMAIL_SILENCE_SECONDS = 5;
// The `RecordingFinished`/`RecordingFailed` fallback's margin past `maxDurationSeconds`.
const RECORDING_FALLBACK_BUFFER_S = 5;

export type RecordingOutcome =
  | { kind: 'finished'; durationS: number }
  | { kind: 'failed' }
  | { kind: 'destroyed' };

// How long a caller channel's destruction waits for the recording's own outcome. Hanging up is
// how a caller ends a message, and Asterisk stops and finalises the recording as the channel
// goes, so `RecordingFinished` follows `ChannelDestroyed` rather than preceding it; resolving on
// the channel alone would discard every message left the ordinary way.
const RECORDING_AFTER_HANGUP_MS = 2000;

/**
 * Starts the recording `options.name` and waits for it to end (§10.2): `RecordingFinished`
 * resolves with its reported duration, `RecordingFailed` with none, for `deposit` to treat as no
 * message recorded. The caller channel going away shortens the wait to
 * `RECORDING_AFTER_HANGUP_MS` instead of ending it, since that is the ordinary end of a message
 * and the recording is finalised just after. A refused record request ends the wait at once, as
 * `destroyed` for a channel that is already gone (a caller who hung up during the greeting, whose
 * `ChannelDestroyed` preceded this listener), since no recording follows either way. `timeoutMs`
 * is the safety net for events that never arrive, so the listener is always eventually removed.
 */
function recordAndWait(
  ari: AriClient,
  channelId: string,
  options: RecordParams,
  timeoutMs: number
): Promise<RecordingOutcome> {
  const wait = waitForEvent<RecordingOutcome>(ari, (ev, waiting) => {
    if (channelLeft(ev, channelId)) {
      // The grace replaces the safety net: the recording's own end is due within it.
      waiting.arm(RECORDING_AFTER_HANGUP_MS, () => {
        waiting.settle({ kind: 'destroyed' });
      });
      return;
    }
    const end = recordingEnd(ev, options.name);
    if (end !== undefined) {
      waiting.settle(
        end === null ? { kind: 'failed' } : { kind: 'finished', durationS: end }
      );
    }
  });
  wait.arm(timeoutMs, () => {
    wait.settle({ kind: 'failed' });
  });
  // Requested once the listener is up, so no outcome of the recording can fire unseen.
  ari.channels.record(channelId, options).catch((error: unknown) => {
    wait.settle({ kind: isGone(error) ? 'destroyed' : 'failed' });
  });
  return wait.promise;
}

/** Records the caller as `name` (§10.2 "Voicemail": capped at `settings.voicemail_max_s`, a 5 s
 * silence stop, `#` to end) and waits for the recording's outcome. */
export async function recordCaller(
  ari: AriClient,
  channelId: string,
  name: string,
  maxDurationSeconds: number
): Promise<RecordingOutcome> {
  const timeoutMs =
    (maxDurationSeconds + RECORDING_FALLBACK_BUFFER_S) * MS_PER_SECOND;
  return recordAndWait(
    ari,
    channelId,
    {
      name,
      format: 'wav',
      maxDurationSeconds,
      maxSilenceSeconds: VOICEMAIL_SILENCE_SECONDS,
      terminateOn: '#'
    },
    timeoutMs
  );
}
